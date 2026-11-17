import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../src/server.js';
import { Transaction } from '../src/transaction.js';
import { createBrowserWallet, createSignedTransaction } from '../public/js/wallet-crypto.js';
import { FAST_CONFIG } from './helpers.js';

// Two real nodes on random ports talking over HTTP: an end-to-end test of the
// REST API, broadcasting and syncing.
const options = { port: 0, dataDir: null, config: FAST_CONFIG, quiet: true };
const nodeA = await createNode(options);
const nodeB = await createNode(options);
nodeA.p2p.addPeer(nodeB.url);
nodeB.p2p.addPeer(nodeA.url);
after(() => Promise.all([nodeA.close(), nodeB.close()]));

async function api(node, path, body) {
  const res = await fetch(`${node.url}${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function waitFor(check, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for: ${message}`);
}

test('wallet -> mine -> send -> mine, and every step propagates to the peer', async () => {
  const { status, data: alice } = await api(nodeA, '/wallet/new', {});
  assert.equal(status, 201);
  assert.match(alice.warning, /LEARNING ONLY/);
  const bob = (await api(nodeA, '/wallet/new', {})).data;

  const mined = await api(nodeA, '/mine', { minerAddress: alice.address });
  assert.equal(mined.status, 201);
  assert.equal(typeof mined.data.nonce, 'number');
  await waitFor(() => nodeB.blockchain.chain.length === 2, 'node B receives block #1');

  const tx = Transaction.create({ wallet: alice, to: bob.address, amount: 15, fee: 1, nonce: 0 });
  assert.equal((await api(nodeA, '/transactions', tx)).status, 201);
  await waitFor(() => nodeB.blockchain.mempool.length === 1, 'node B receives the transaction');

  assert.equal((await api(nodeB, '/mine', { minerAddress: bob.address })).status, 201);
  await waitFor(() => nodeA.blockchain.chain.length === 3, 'node A receives block #2');

  const balance = (await api(nodeA, `/balance/${bob.address}`)).data;
  assert.equal(balance.balance, 15 + 50 + 1, 'payment + reward + fee');
  const found = (await api(nodeA, `/tx/${tx.hash}`)).data;
  assert.equal(found.status, 'confirmed');
  assert.equal(found.blockIndex, 2);
  assert.equal(nodeA.blockchain.mempool.length, 0);
});

test('a browser-signed (P-256) transaction is accepted over HTTP', async () => {
  const wallet = await createBrowserWallet();
  await api(nodeA, '/mine', { minerAddress: wallet.address });
  const { nextNonce } = (await api(nodeA, `/balance/${wallet.address}`)).data;
  const tx = await createSignedTransaction(wallet, { to: 'ab'.repeat(20), amount: 5, fee: 0, nonce: nextNonce });
  const res = await api(nodeA, '/transactions', tx);
  assert.equal(res.status, 201, JSON.stringify(res.data));
});

test('a node that missed blocks catches up through consensus', async () => {
  const nodeC = await createNode(options);
  try {
    // C mines alone on a short fork, then joins the network.
    await api(nodeC, '/mine', { minerAddress: 'cd'.repeat(20) });
    await api(nodeC, '/peers', { url: nodeA.url });
    await waitFor(() => nodeC.blockchain.latestBlock.hash === nodeA.blockchain.latestBlock.hash, 'node C adopts the heavier chain');
  } finally {
    await nodeC.close();
  }
});

test('errors are JSON with proper status codes', async () => {
  assert.equal((await api(nodeA, '/blocks/999')).status, 404);
  assert.equal((await api(nodeA, '/balance/not-an-address')).status, 400);
  assert.equal((await api(nodeA, '/mine', { minerAddress: 'nope' })).status, 400);
  const bad = await api(nodeA, '/transactions', { from: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.data.error, 'string');
  assert.equal((await api(nodeA, '/no-such-route')).status, 404);
});

test('the frontend is served by the node', async () => {
  const res = await fetch(`${nodeA.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${nodeA.url}/..%2Fpackage.json`)).status, 404, 'no path traversal');
});
