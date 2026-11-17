import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Block } from '../src/block.js';
import { sha256 } from '../src/crypto-utils.js';
import { Transaction } from '../src/transaction.js';
import { generateWallet } from '../src/wallet.js';

const h = (s) => sha256(s);

test('Merkle root of a single hash is that hash', () => {
  assert.equal(Block.computeMerkleRoot([h('a')]), h('a'));
});

test('Merkle root of two hashes is H(h1 + h2)', () => {
  assert.equal(Block.computeMerkleRoot([h('a'), h('b')]), sha256(h('a') + h('b')));
});

test('Merkle root with an odd count duplicates the last hash', () => {
  const [a, b, c] = [h('a'), h('b'), h('c')];
  const expected = sha256(sha256(a + b) + sha256(c + c));
  assert.equal(Block.computeMerkleRoot([a, b, c]), expected);
});

test('Merkle root of four hashes builds a two-level tree', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(h);
  assert.equal(Block.computeMerkleRoot([a, b, c, d]), sha256(sha256(a + b) + sha256(c + d)));
});

test('Merkle root changes when any transaction changes', () => {
  assert.notEqual(Block.computeMerkleRoot([h('a'), h('b')]), Block.computeMerkleRoot([h('a'), h('B')]));
});

function sampleBlock(difficulty) {
  const miner = generateWallet();
  const coinbase = Transaction.coinbase({ minerAddress: miner.address, amount: 50, blockIndex: 1, timestamp: Date.now() });
  return new Block({ index: 1, timestamp: Date.now(), transactions: [coinbase], previousHash: '0'.repeat(64), difficulty });
}

test('proof of work: a mined hash has `difficulty` leading zeros', () => {
  for (const difficulty of [1, 2, 3]) {
    const block = sampleBlock(difficulty);
    const { attempts } = block.mine();
    assert.ok(block.hash.startsWith('0'.repeat(difficulty)), `hash ${block.hash} at difficulty ${difficulty}`);
    assert.equal(block.hash, block.calculateHash());
    assert.equal(block.hasValidProofOfWork(), true);
    assert.equal(attempts, block.nonce + 1);
  }
});

test('changing a mined block breaks its proof of work', () => {
  const block = sampleBlock(3);
  block.mine();
  block.timestamp += 1;
  assert.equal(block.hasValidProofOfWork(), false);
});

test('a block survives a JSON round trip unchanged', () => {
  const block = sampleBlock(2);
  block.mine();
  const copy = Block.from(JSON.parse(JSON.stringify(block)));
  assert.equal(copy.hash, block.hash);
  assert.equal(copy.calculateHash(), block.hash);
  assert.equal(copy.merkleRoot, block.merkleRoot);
});
