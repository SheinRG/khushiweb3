import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Blockchain } from '../src/blockchain.js';
import { Block } from '../src/block.js';
import { Transaction } from '../src/transaction.js';
import { generateWallet } from '../src/wallet.js';
import { newChain, mineBlocks, pay, clone, FAST_CONFIG } from './helpers.js';

const alice = generateWallet();
const bob = generateWallet();
const carol = generateWallet();
const miner = generateWallet();

test('a new chain starts with the hardcoded genesis block', () => {
  const a = newChain();
  const b = newChain();
  assert.equal(a.chain.length, 1);
  assert.equal(a.latestBlock.hash, b.latestBlock.hash, 'every node builds the same genesis');
});

test('mining pays the block reward to the miner', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address);
  assert.equal(chain.chain.length, 2);
  assert.deepEqual(chain.getAccount(alice.address), { balance: 50, nonce: 0 });
});

test('a mined transaction moves coins, pays the fee to the miner and bumps the nonce', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address);
  pay(chain, alice, bob.address, 20, 2);
  mineBlocks(chain, miner.address);

  assert.deepEqual(chain.getAccount(alice.address), { balance: 28, nonce: 1 });
  assert.deepEqual(chain.getAccount(bob.address), { balance: 20, nonce: 0 });
  assert.equal(chain.getAccount(miner.address).balance, 50 + 2, 'reward + fee');
  assert.equal(chain.mempool.length, 0);
});

test('the mempool rejects duplicates and invalid transactions', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address);
  const tx = Transaction.create({ wallet: alice, to: bob.address, amount: 5, nonce: 0 });
  chain.addTransaction(tx);
  assert.throws(() => chain.addTransaction(tx), /already in the mempool/);
  assert.throws(() => pay(chain, bob, alice.address, 1), /insufficient balance/);
  assert.throws(() => chain.addTransaction({ ...tx.toJSON(), amount: 6 }), /hash does not match/);
});

test('pending transactions are counted: no double spending while waiting in the mempool', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address); // alice has 50
  pay(chain, alice, bob.address, 30);
  assert.throws(() => pay(chain, alice, carol.address, 30), /insufficient balance/);
  pay(chain, alice, carol.address, 20); // the remaining 20 is fine (nonce 1)
  assert.deepEqual(chain.getPendingAccount(alice.address), { balance: 0, nonce: 2 });
});

test('replay: re-sending an already mined transaction is rejected', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address);
  const tx = pay(chain, alice, bob.address, 5);
  mineBlocks(chain, miner.address);
  assert.throws(() => chain.addTransaction(clone(tx)), /already confirmed/);
});

test('double spend: two transactions with the same nonce, only one gets in', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address);
  const toBob = Transaction.create({ wallet: alice, to: bob.address, amount: 40, nonce: 0 });
  const toCarol = Transaction.create({ wallet: alice, to: carol.address, amount: 40, nonce: 0 });

  chain.addTransaction(toBob);
  assert.throws(() => chain.addTransaction(toCarol), /wrong nonce/);

  // Even a miner who forces both into one block produces an invalid block.
  const block = new Block({
    index: 2,
    timestamp: Date.now(),
    previousHash: chain.latestBlock.hash,
    difficulty: chain.nextDifficulty(),
    transactions: [Transaction.coinbase({ minerAddress: miner.address, amount: 50, blockIndex: 2, timestamp: Date.now() }), toBob, toCarol],
  });
  block.mine();
  const result = chain.addBlock(block);
  assert.equal(result.added, false);
  assert.match(result.reason, /wrong nonce/);

  mineBlocks(chain, miner.address);
  assert.equal(chain.getAccount(bob.address).balance, 40);
  assert.equal(chain.getAccount(carol.address).balance, 0);
});

test('miners pick the highest fees first but keep each sender\'s nonce order', () => {
  const chain = newChain({ MAX_TX_PER_BLOCK: 2 });
  mineBlocks(chain, alice.address);
  mineBlocks(chain, bob.address);
  pay(chain, alice, carol.address, 1, 1); // nonce 0, low fee
  pay(chain, alice, carol.address, 1, 9); // nonce 1, high fee (needs nonce 0 first)
  pay(chain, bob, carol.address, 1, 5);

  const picked = chain.selectTransactions();
  assert.deepEqual(picked.map((tx) => tx.fee), [5, 1], 'bob (5) first, then alice nonce 0; nonce 1 must wait');
});

test('the coinbase must pay exactly reward + fees', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address);
  const greedy = new Block({
    index: 2,
    timestamp: Date.now(),
    previousHash: chain.latestBlock.hash,
    difficulty: chain.nextDifficulty(),
    transactions: [Transaction.coinbase({ minerAddress: miner.address, amount: 5000, blockIndex: 2, timestamp: Date.now() })],
  });
  greedy.mine();
  assert.match(chain.addBlock(greedy).reason, /coinbase must pay exactly 50/);
});

test('a valid chain passes full validation', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address);
  pay(chain, alice, bob.address, 10, 1);
  mineBlocks(chain, miner.address, 2);
  assert.deepEqual(chain.isValidChain(clone(chain.chain)).valid, true);
});

test('a chain with a tampered block fails validation', () => {
  const chain = newChain();
  mineBlocks(chain, alice.address);
  pay(chain, alice, bob.address, 10);
  mineBlocks(chain, miner.address, 2);

  const changedAmount = clone(chain.chain);
  changedAmount[2].transactions[1].amount = 1000;
  assert.match(chain.isValidChain(changedAmount).error, /hash does not match/);

  const changedCoinbase = clone(chain.chain);
  changedCoinbase[1].transactions[0].to = carol.address;
  changedCoinbase[1].transactions[0].hash = Transaction.from(changedCoinbase[1].transactions[0]).calculateHash();
  assert.match(chain.isValidChain(changedCoinbase).error, /merkle root/);

  // Fully re-mine the tampered block: its hash changes, so the NEXT block's link breaks.
  const remined = clone(chain.chain);
  remined[1].transactions[0].to = carol.address;
  const block = Block.from({ ...remined[1], transactions: [Transaction.coinbase({ minerAddress: carol.address, amount: 50, blockIndex: 1, timestamp: remined[1].timestamp })], merkleRoot: null, hash: null });
  block.mine();
  remined[1] = clone(block);
  assert.match(chain.isValidChain(remined).error, /block #2: previousHash/);

  const badGenesis = clone(chain.chain);
  badGenesis[0].timestamp = 1;
  assert.match(chain.isValidChain(badGenesis).error, /genesis/);
});

test('difficulty rises when blocks are too fast and falls when too slow (never below 1)', () => {
  const chain = newChain({ DIFFICULTY_ADJUSTMENT_INTERVAL: 5, TARGET_BLOCK_TIME_MS: 10_000, MAX_DIFFICULTY: 5 });
  const fake = (times, difficulty) => times.map((timestamp, index) => ({ index, timestamp, difficulty }));

  // Blocks every 1s (target 10s) -> harder.
  assert.equal(chain.expectedDifficulty(fake([0, 1000, 2000, 3000, 4000], 3), 5), 4);
  // Blocks every 60s -> easier.
  assert.equal(chain.expectedDifficulty(fake([0, 60e3, 120e3, 180e3, 240e3], 3), 5), 2);
  // On target -> unchanged.
  assert.equal(chain.expectedDifficulty(fake([0, 10e3, 20e3, 30e3, 40e3], 3), 5), 3);
  // Never below MIN_DIFFICULTY.
  assert.equal(chain.expectedDifficulty(fake([0, 60e3, 120e3, 180e3, 240e3], 1), 5), 1);
  // Only recalculated every N blocks.
  assert.equal(chain.expectedDifficulty(fake([0, 1, 2, 3], 3), 4), 3);
});

test('mining fast for one interval really raises the difficulty', () => {
  const chain = newChain({ DIFFICULTY_ADJUSTMENT_INTERVAL: 4 });
  mineBlocks(chain, miner.address, 4);
  assert.equal(chain.latestBlock.index, 4);
  assert.equal(chain.latestBlock.difficulty, FAST_CONFIG.INITIAL_DIFFICULTY + 1);
  assert.equal(chain.isValidChain(clone(chain.chain)).valid, true);
});

test('chain and mempool are saved to disk and loaded on startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'minichain-'));
  try {
    const dataFile = join(dir, 'node-test.json');
    const first = new Blockchain({ config: FAST_CONFIG, dataFile });
    mineBlocks(first, alice.address);
    pay(first, alice, bob.address, 5);

    const second = new Blockchain({ config: FAST_CONFIG, dataFile });
    assert.equal(second.chain.length, 2);
    assert.equal(second.latestBlock.hash, first.latestBlock.hash);
    assert.equal(second.mempool.length, 1);
    assert.equal(second.getAccount(alice.address).balance, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
