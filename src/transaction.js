import { sha256, stableStringify, isHex, isAddress } from './crypto-utils.js';
import { sign, verify, addressFromPublicKey } from './wallet.js';
import { ChainError } from './errors.js';

// Sender used by the special transaction that creates new coins for a miner.
export const COINBASE = 'COINBASE';

// MiniChain uses the ACCOUNT MODEL (like Ethereum): the ledger is a table of
// address -> { balance, nonce }. Bitcoin instead uses UTXOs ("unspent coins").
//
// Amounts and fees are whole numbers (think "satoshis"): floating point
// rounding errors are unacceptable when counting money.
export class Transaction {
  constructor({ from, to, amount, fee = 0, nonce, timestamp = Date.now(), publicKey = null, signature = null, hash = null }) {
    this.from = from;
    this.to = to;
    this.amount = amount;
    this.fee = fee;
    this.nonce = nonce; // the sender's transaction counter: 0, 1, 2, ...
    this.timestamp = timestamp;
    this.publicKey = publicKey;
    this.signature = signature;
    this.hash = hash ?? this.calculateHash();
  }

  // Every field except the signature is hashed. The signature cannot be
  // included because it is computed FROM this hash.
  signingPayload() {
    const { from, to, amount, fee, nonce, timestamp, publicKey } = this;
    return { from, to, amount, fee, nonce, timestamp, publicKey };
  }

  calculateHash() {
    return sha256(stableStringify(this.signingPayload()));
  }

  isCoinbase() {
    return this.from === COINBASE;
  }

  // Signing the hash commits the owner to every field at once: changing
  // amount, recipient, fee or nonce changes the hash and breaks the signature.
  signWith(privateKeyPem) {
    this.hash = this.calculateHash();
    this.signature = sign(this.hash, privateKeyPem);
    return this;
  }

  static create({ wallet, to, amount, fee = 0, nonce, timestamp }) {
    return new Transaction({ from: wallet.address, to, amount, fee, nonce, timestamp, publicKey: wallet.publicKey })
      .signWith(wallet.privateKey);
  }

  // The coinbase pays the block reward + all fees to the miner. It has no
  // signature: its validity comes from the block rules. The nonce is set to
  // the block index so that every coinbase has a unique hash.
  static coinbase({ minerAddress, amount, blockIndex, timestamp }) {
    return new Transaction({ from: COINBASE, to: minerAddress, amount, fee: 0, nonce: blockIndex, timestamp });
  }

  // Rebuild a Transaction from untrusted JSON, keeping only known fields.
  static from(data) {
    if (data instanceof Transaction) return data;
    if (!data || typeof data !== 'object') throw new ChainError('transaction must be a JSON object');
    const { from, to, amount, fee, nonce, timestamp, publicKey, signature, hash } = data;
    return new Transaction({ from, to, amount, fee, nonce, timestamp, publicKey, signature, hash: hash ?? null });
  }

  // Checks that need NO ledger state: shape, hash integrity, ownership, signature.
  // Returns an error message, or null when everything is fine.
  checkIntegrity() {
    if (!Number.isSafeInteger(this.amount) || this.amount <= 0) return 'amount must be a positive whole number';
    if (!Number.isSafeInteger(this.fee) || this.fee < 0) return 'fee must be a whole number >= 0';
    if (!Number.isSafeInteger(this.nonce) || this.nonce < 0) return 'nonce must be a whole number >= 0';
    if (!Number.isSafeInteger(this.timestamp) || this.timestamp <= 0) return 'timestamp must be a positive integer (ms)';
    if (!isAddress(this.to)) return '"to" must be a 40-character hex address';
    if (this.hash !== this.calculateHash()) return 'hash does not match the transaction contents (was it tampered with?)';

    if (this.isCoinbase()) {
      if (this.fee !== 0 || this.signature !== null || this.publicKey !== null) return 'malformed coinbase transaction';
      return null;
    }

    if (!isAddress(this.from)) return '"from" must be a 40-character hex address';
    if (!isHex(this.publicKey)) return 'publicKey is missing or not hex';
    if (addressFromPublicKey(this.publicKey) !== this.from) return 'publicKey does not belong to the "from" address';
    if (!isHex(this.signature)) return 'signature is missing or not hex';
    if (!verify(this.hash, this.signature, this.publicKey)) return 'invalid signature';
    return null;
  }

  toJSON() {
    const { from, to, amount, fee, nonce, timestamp, publicKey, signature, hash } = this;
    return { hash, from, to, amount, fee, nonce, timestamp, publicKey, signature };
  }
}

// Full validation of a user transaction against the sender's current account.
//   nonce must equal the account's nonce -> a signed transaction can be used
//   only once (REPLAY PROTECTION), and two spends with the same nonce can
//   never both be accepted (DOUBLE-SPEND PROTECTION).
export function validateTransaction(tx, account = { balance: 0, nonce: 0 }) {
  const integrityError = tx.checkIntegrity();
  if (integrityError) return { valid: false, error: integrityError };
  if (tx.isCoinbase()) return { valid: false, error: 'coinbase transactions can only be created by a miner inside a block' };
  if (tx.nonce !== account.nonce) {
    return { valid: false, error: `wrong nonce: expected ${account.nonce}, got ${tx.nonce} (replay/double-spend protection)` };
  }
  const cost = tx.amount + tx.fee;
  if (account.balance < cost) {
    return { valid: false, error: `insufficient balance: has ${account.balance}, needs ${cost} (amount + fee)` };
  }
  return { valid: true, error: null };
}
