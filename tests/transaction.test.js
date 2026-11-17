import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWallet, sign } from '../src/wallet.js';
import { Transaction, validateTransaction } from '../src/transaction.js';
import { createBrowserWallet, createSignedTransaction } from '../public/js/wallet-crypto.js';

const alice = generateWallet();
const bob = generateWallet();
const rich = { balance: 100, nonce: 0 };

const aliceTx = (overrides = {}) =>
  Transaction.create({ wallet: alice, to: bob.address, amount: 10, fee: 1, nonce: 0, ...overrides });

test('a correctly signed transaction is valid', () => {
  assert.deepEqual(validateTransaction(aliceTx(), rich), { valid: true, error: null });
});

test('the hash covers every field except the signature', () => {
  const tx = aliceTx();
  const hashBefore = tx.hash;
  tx.signature = 'ff'.repeat(64);
  assert.equal(tx.calculateHash(), hashBefore);
  tx.amount = 11;
  assert.notEqual(tx.calculateHash(), hashBefore);
});

test('a tampered transaction (amount changed after signing) is rejected', () => {
  const tx = Transaction.from({ ...aliceTx().toJSON(), amount: 99 });
  const { valid, error } = validateTransaction(tx, rich);
  assert.equal(valid, false);
  assert.match(error, /hash does not match/);
});

test('a tampered transaction with a recomputed hash fails the signature check', () => {
  const tx = aliceTx();
  tx.to = generateWallet().address;
  tx.hash = tx.calculateHash(); // attacker fixes the hash, but cannot re-sign
  assert.match(validateTransaction(tx, rich).error, /invalid signature/);
});

test('a signature made with another key is rejected', () => {
  const tx = aliceTx();
  tx.signature = sign(tx.hash, bob.privateKey);
  assert.match(validateTransaction(tx, rich).error, /invalid signature/);
});

test('a public key that does not match the "from" address is rejected', () => {
  const tx = new Transaction({ from: alice.address, to: bob.address, amount: 5, fee: 0, nonce: 0, publicKey: bob.publicKey })
    .signWith(bob.privateKey);
  assert.match(validateTransaction(tx, rich).error, /does not belong/);
});

test('amount must be > 0 and fee must be >= 0', () => {
  assert.match(validateTransaction(aliceTx({ amount: 0 }), rich).error, /amount/);
  assert.match(validateTransaction(aliceTx({ amount: -5 }), rich).error, /amount/);
  assert.match(validateTransaction(aliceTx({ amount: 1.5 }), rich).error, /amount/);
  assert.match(validateTransaction(aliceTx({ fee: -1 }), rich).error, /fee/);
});

test('insufficient balance (amount + fee) is rejected', () => {
  const { valid, error } = validateTransaction(aliceTx({ amount: 10, fee: 1 }), { balance: 10, nonce: 0 });
  assert.equal(valid, false);
  assert.match(error, /insufficient balance/);
});

test('a wrong nonce (replay) is rejected', () => {
  const tx = aliceTx({ nonce: 0 });
  // After the tx is mined, alice's nonce becomes 1, so replaying it fails.
  assert.match(validateTransaction(tx, { balance: 100, nonce: 1 }).error, /wrong nonce/);
  assert.match(validateTransaction(aliceTx({ nonce: 5 }), rich).error, /wrong nonce/);
});

test('users cannot submit coinbase transactions', () => {
  const coinbase = Transaction.coinbase({ minerAddress: alice.address, amount: 50, blockIndex: 1, timestamp: Date.now() });
  assert.equal(coinbase.checkIntegrity(), null);
  assert.match(validateTransaction(coinbase, rich).error, /coinbase/);
});

test('a transaction signed in the browser (Web Crypto, P-256) verifies on the server', async () => {
  const browserWallet = await createBrowserWallet();
  const json = await createSignedTransaction(browserWallet, { to: bob.address, amount: 7, fee: 1, nonce: 0 });
  const tx = Transaction.from(json);
  assert.equal(tx.hash, json.hash, 'browser and server compute the same hash');
  assert.deepEqual(validateTransaction(tx, rich), { valid: true, error: null });

  const tampered = Transaction.from({ ...json, amount: 70 });
  tampered.hash = tampered.calculateHash();
  assert.match(validateTransaction(tampered, rich).error, /invalid signature/);
});
