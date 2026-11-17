import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blockchain } from '../src/blockchain.js';
import { Transaction } from '../src/transaction.js';
import { generateWallet } from '../src/wallet.js';
import { newChain, mineBlocks, pay, clone } from './helpers.js';

const alice = generateWallet();
const bob = generateWallet();
const carol = generateWallet();
const minerA = generateWallet();
const minerB = generateWallet();

test('cumulative work counts difficulty, not just length', () => {
  const longButEasy = Array.from({ length: 10 }, () => ({ difficulty: 1 })); // 10 * 16 = 160
  const shortButHard = [{ difficulty: 1 }, { difficulty: 3 }]; // 16 + 4096
  assert.ok(Blockchain.cumulativeWork(shortButHard) > Blockchain.cumulativeWork(longButEasy));
});

test('consensus adopts a valid chain with more cumulative work', () => {
  const nodeA = newChain();
  const nodeB = newChain();
  mineBlocks(nodeA, minerA.address, 2);
  mineBlocks(nodeB, minerB.address, 3);

  const result = nodeA.replaceChain(clone(nodeB.chain));
  assert.equal(result.replaced, true);
  assert.equal(nodeA.latestBlock.hash, nodeB.latestBlock.hash);
  assert.equal(nodeA.getAccount(minerA.address).balance, 0, 'minerA\'s blocks were orphaned');
  assert.equal(nodeA.getAccount(minerB.address).balance, 150);
});

test('consensus keeps our chain when the other has less or equal work', () => {
  const nodeA = newChain();
  const nodeB = newChain();
  mineBlocks(nodeA, minerA.address, 3);
  mineBlocks(nodeB, minerB.address, 3);
  assert.equal(nodeA.replaceChain(clone(nodeB.chain)).replaced, false, 'equal work: first seen wins');
  mineBlocks(nodeB, minerB.address, 1);
  assert.equal(nodeB.replaceChain(clone(nodeA.chain)).replaced, false, 'less work');
});

test('consensus rejects an invalid chain even if it is longer', () => {
  const nodeA = newChain();
  const nodeB = newChain();
  mineBlocks(nodeA, minerA.address, 1);
  mineBlocks(nodeB, minerB.address, 5);
  const forged = clone(nodeB.chain);
  forged[3].transactions[0].amount = 1_000_000;
  const result = nodeA.replaceChain(forged);
  assert.equal(result.replaced, false);
  assert.match(result.reason, /invalid chain/);
  assert.equal(nodeA.chain.length, 2);
});

test('after a chain swap, transactions already included are dropped from the mempool', () => {
  const nodeA = newChain();
  mineBlocks(nodeA, alice.address);
  const nodeB = newChain();
  nodeB.replaceChain(clone(nodeA.chain)); // both nodes share the same history

  const tx = Transaction.create({ wallet: alice, to: bob.address, amount: 10, nonce: 0 });
  nodeA.addTransaction(clone(tx));
  nodeB.addTransaction(clone(tx));
  mineBlocks(nodeB, minerB.address);

  assert.equal(nodeA.replaceChain(clone(nodeB.chain)).replaced, true);
  assert.equal(nodeA.mempool.length, 0);
  assert.equal(nodeA.getAccount(bob.address).balance, 10);
});

test('transactions from orphaned blocks go back into the mempool', () => {
  const nodeA = newChain();
  mineBlocks(nodeA, alice.address);
  const nodeB = newChain();
  nodeB.replaceChain(clone(nodeA.chain));

  pay(nodeA, alice, bob.address, 10);
  mineBlocks(nodeA, minerA.address); // tx confirmed on A's fork only
  mineBlocks(nodeB, minerB.address, 2); // B's fork has more work

  const result = nodeA.replaceChain(clone(nodeB.chain));
  assert.equal(result.orphanedTxs, 1);
  assert.equal(nodeA.mempool.length, 1, 'the tx is pending again, not lost');
  mineBlocks(nodeA, minerA.address);
  assert.equal(nodeA.getAccount(bob.address).balance, 10);
});

test('double spend across two nodes: after consensus only one payment survives', () => {
  const nodeA = newChain();
  mineBlocks(nodeA, alice.address); // alice: 50
  const nodeB = newChain();
  nodeB.replaceChain(clone(nodeA.chain));

  // Alice signs two conflicting payments (same nonce) and sends one to each node.
  nodeA.addTransaction(Transaction.create({ wallet: alice, to: bob.address, amount: 50, nonce: 0 }));
  nodeB.addTransaction(Transaction.create({ wallet: alice, to: carol.address, amount: 50, nonce: 0 }));
  mineBlocks(nodeA, minerA.address);
  mineBlocks(nodeB, minerB.address, 2); // B's fork wins

  nodeA.replaceChain(clone(nodeB.chain));
  assert.equal(nodeA.getAccount(carol.address).balance, 50);
  assert.equal(nodeA.getAccount(bob.address).balance, 0);
  assert.equal(nodeA.mempool.length, 0, 'the losing payment is now invalid (nonce used) and dropped');
});
