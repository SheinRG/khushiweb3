import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateWallet } from './wallet.js';
import { Transaction } from './transaction.js';

// A tiny command-line wallet. It shows the RIGHT way to use a blockchain:
// keys are created and transactions are signed locally, and only the signed
// transaction is sent to a node. The node never sees the private key.
//
//   node src/cli.js wallet wallets/alice.json
//   node src/cli.js balance <address>
//   node src/cli.js send wallets/alice.json <toAddress> <amount> [fee]
//   node src/cli.js mine <minerAddress>
// Add --node http://localhost:3002 to talk to another node (default 3001).

const args = process.argv.slice(2);
const nodeFlag = args.indexOf('--node');
const NODE = nodeFlag >= 0 ? args.splice(nodeFlag, 2)[1] : 'http://localhost:3001';
const [command, ...rest] = args;

async function api(path, body) {
  const res = await fetch(`${NODE}${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

const commands = {
  wallet([file = 'wallets/wallet.json']) {
    const wallet = generateWallet();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(wallet, null, 2));
    console.log(`New wallet saved to ${file} (keep the private key secret!)\naddress: ${wallet.address}`);
  },

  async balance([address]) {
    console.log(await api(`/balance/${address}`));
  },

  async send([file, to, amount, fee = '0']) {
    const wallet = JSON.parse(readFileSync(file, 'utf8'));
    const { nextNonce } = await api(`/balance/${wallet.address}`);
    const tx = Transaction.create({ wallet, to, amount: Number(amount), fee: Number(fee), nonce: nextNonce });
    const result = await api('/transactions', tx);
    console.log(`${result.message}\nhash: ${tx.hash}`);
  },

  async mine([minerAddress]) {
    const { message, timeMs, nonce, block } = await api('/mine', { minerAddress });
    console.log(`${message} in ${timeMs}ms, nonce ${nonce}\nhash: ${block.hash}`);
  },
};

if (!commands[command]) {
  console.log('usage: node src/cli.js <wallet|balance|send|mine> ... [--node http://localhost:3001]');
  process.exit(1);
}
try {
  await commands[command](rest);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
