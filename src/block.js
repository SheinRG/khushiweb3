import { sha256, stableStringify } from './crypto-utils.js';
import { Transaction } from './transaction.js';
import { ChainError } from './errors.js';

// A block = a HEADER (small) + a list of transactions (big).
// The header holds the Merkle root, which commits to every transaction, so
// hashing just the header is enough to seal the whole block.
// previousHash points at the parent block's hash: change any old block and
// every later link breaks. That chain of hashes IS the "blockchain".
export class Block {
  constructor({ index, timestamp, transactions = [], previousHash, merkleRoot, nonce = 0, difficulty, hash }) {
    if (!Array.isArray(transactions)) throw new ChainError('block.transactions must be an array');
    this.index = index;
    this.timestamp = timestamp;
    this.transactions = transactions.map((tx) => Transaction.from(tx));
    this.previousHash = previousHash;
    this.merkleRoot = merkleRoot ?? Block.computeMerkleRoot(this.transactions.map((tx) => tx.hash));
    this.nonce = nonce;
    this.difficulty = difficulty;
    this.hash = hash ?? this.calculateHash();
  }

  headerPayload() {
    const { index, timestamp, previousHash, merkleRoot, nonce, difficulty } = this;
    return { index, timestamp, previousHash, merkleRoot, nonce, difficulty };
  }

  calculateHash() {
    return sha256(stableStringify(this.headerPayload()));
  }

  // MERKLE TREE: hash transactions in pairs, then pair those hashes, and so
  // on until one hash (the root) is left. With an odd count, the last hash
  // is paired with itself (Bitcoin does the same).
  //
  //            root = H(H12 + H33)
  //           /                 \
  //     H12 = H(h1+h2)     H33 = H(h3+h3)
  //       /     \             /     \
  //     h1      h2          h3     (h3 copy)
  //
  // Bonus: a light client can prove one transaction is in a block with only
  // log2(n) hashes (a "Merkle proof") instead of downloading the whole block.
  static computeMerkleRoot(hashes) {
    if (hashes.length === 0) return '0'.repeat(64);
    let level = [...hashes];
    while (level.length > 1) {
      if (level.length % 2 === 1) level.push(level[level.length - 1]);
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
      level = next;
    }
    return level[0];
  }

  // PROOF OF WORK: try nonce = 0, 1, 2, ... until the hash starts with
  // `difficulty` zeros. There is no shortcut, so a valid hash proves work was
  // spent; yet anyone can check it with a single hash.
  mine() {
    const target = '0'.repeat(this.difficulty);
    const startedAt = Date.now();
    let attempts = 0;
    this.nonce = 0;
    for (;;) {
      this.hash = this.calculateHash();
      attempts++;
      if (this.hash.startsWith(target)) break;
      this.nonce++;
    }
    return { attempts, timeMs: Date.now() - startedAt };
  }

  hasValidProofOfWork() {
    return this.hash === this.calculateHash() && this.hash.startsWith('0'.repeat(this.difficulty));
  }

  static from(data) {
    if (data instanceof Block) return data;
    if (!data || typeof data !== 'object') throw new ChainError('block must be a JSON object');
    return new Block({ ...data, hash: data.hash ?? null, merkleRoot: data.merkleRoot ?? null });
  }

  toJSON() {
    const { index, timestamp, previousHash, merkleRoot, nonce, difficulty, hash, transactions } = this;
    return { index, hash, previousHash, timestamp, nonce, difficulty, merkleRoot, transactions };
  }
}
