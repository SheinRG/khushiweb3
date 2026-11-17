import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWallet, sign, verify, addressFromPublicKey } from '../src/wallet.js';

test('a new wallet has a secp256k1 key pair and a 40-hex-char address', () => {
  const wallet = generateWallet();
  assert.equal(wallet.curve, 'secp256k1');
  assert.match(wallet.address, /^[0-9a-f]{40}$/);
  assert.match(wallet.privateKey, /BEGIN PRIVATE KEY/);
  assert.equal(addressFromPublicKey(wallet.publicKey), wallet.address);
});

test('two wallets never share an address', () => {
  assert.notEqual(generateWallet().address, generateWallet().address);
});

test('a signature verifies with the matching public key', () => {
  const wallet = generateWallet();
  const signature = sign('hello minichain', wallet.privateKey);
  assert.equal(verify('hello minichain', signature, wallet.publicKey), true);
});

test('a signature fails for different data', () => {
  const wallet = generateWallet();
  const signature = sign('pay bob 5', wallet.privateKey);
  assert.equal(verify('pay bob 500', signature, wallet.publicKey), false);
});

test('a signature fails with somebody else\'s public key', () => {
  const alice = generateWallet();
  const mallory = generateWallet();
  const signature = sign('pay bob 5', mallory.privateKey);
  assert.equal(verify('pay bob 5', signature, alice.publicKey), false);
});

test('garbage signatures and keys are rejected without throwing', () => {
  const wallet = generateWallet();
  assert.equal(verify('data', 'zz-not-hex', wallet.publicKey), false);
  assert.equal(verify('data', 'ab'.repeat(64), wallet.publicKey), false);
  assert.equal(verify('data', 'ab'.repeat(64), 'deadbeef'), false);
});
