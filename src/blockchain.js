import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Block } from './block.js';
import { Transaction, validateTransaction } from './transaction.js';
import { DEFAULT_CONFIG } from './config.js';
import { ChainError } from './errors.js';
import { isAddress, shortHash } from './crypto-utils.js';

// ---------------------------------------------------------------------------
// Ledger state helpers.
// The blockchain stores only TRANSACTIONS, never balances. Balances and nonces
// are DERIVED by replaying every transaction from the genesis block. Every
// node that replays the same chain ends up with exactly the same state.
// ---------------------------------------------------------------------------

function accountOf(state, address) {
  return state.get(address) ?? { balance: 0, nonce: 0 };
}

function applyTransaction(state, tx) {
  if (!tx.isCoinbase()) {
    const sender = accountOf(state, tx.from);
    state.set(tx.from, { balance: sender.balance - tx.amount - tx.fee, nonce: sender.nonce + 1 });
  }
  const receiver = accountOf(state, tx.to);
  state.set(tx.to, { ...receiver, balance: receiver.balance + tx.amount });
  // The fee is not credited here: it reaches the miner through the coinbase.
}

// Every rule a block must follow. `state` is the ledger BEFORE the block and
// is updated in place. Throws an Error describing the first broken rule.
function validateBlock(block, previous, state, knownTxHashes, expectedDifficulty, config) {
  const fail = (msg) => { throw new Error(`block #${block.index}: ${msg}`); };

  if (block.index !== previous.index + 1) fail('index does not follow the previous block');
  if (block.previousHash !== previous.hash) fail('previousHash does not link to the previous block');
  if (block.hash !== block.calculateHash()) fail('hash does not match block contents (was it tampered with?)');
  if (block.difficulty !== expectedDifficulty) fail(`wrong difficulty: expected ${expectedDifficulty}, got ${block.difficulty}`);
  if (!block.hasValidProofOfWork()) fail(`proof of work missing: hash needs ${block.difficulty} leading zeros`);
  if (block.merkleRoot !== Block.computeMerkleRoot(block.transactions.map((tx) => tx.hash))) fail('merkle root does not match the transactions');
  if (!Number.isSafeInteger(block.timestamp) || block.timestamp < previous.timestamp) fail('timestamp is before the previous block');
  if (block.timestamp > Date.now() + config.MAX_FUTURE_DRIFT_MS) fail('timestamp is too far in the future');

  const [coinbase, ...userTxs] = block.transactions;
  if (!coinbase || !coinbase.isCoinbase()) fail('first transaction must be the coinbase');
  if (userTxs.length > config.MAX_TX_PER_BLOCK) fail(`too many transactions (max ${config.MAX_TX_PER_BLOCK})`);

  // Transactions are applied in order, so a later tx sees earlier ones' effects.
  const seenInBlock = new Set();
  let totalFees = 0;
  for (const tx of userTxs) {
    if (knownTxHashes.has(tx.hash) || seenInBlock.has(tx.hash)) fail(`duplicate transaction ${shortHash(tx.hash)}`);
    const { valid, error } = validateTransaction(tx, accountOf(state, tx.from));
    if (!valid) fail(`transaction ${shortHash(tx.hash)}: ${error}`);
    applyTransaction(state, tx);
    seenInBlock.add(tx.hash);
    totalFees += tx.fee;
  }

  // The miner may pay itself exactly reward + fees. Not one coin more.
  const coinbaseError = coinbase.checkIntegrity();
  if (coinbaseError) fail(`coinbase: ${coinbaseError}`);
  const expectedPayout = config.BLOCK_REWARD + totalFees;
  if (coinbase.amount !== expectedPayout) fail(`coinbase must pay exactly ${expectedPayout} (reward + fees), got ${coinbase.amount}`);
  if (coinbase.nonce !== block.index) fail('coinbase nonce must equal the block index');
  applyTransaction(state, coinbase);
}

export class Blockchain {
  constructor({ config = {}, dataFile = null } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dataFile = dataFile;
    this.chain = [Blockchain.createGenesisBlock(this.config)];
    this.mempool = []; // valid transactions waiting to be mined
    this._cache = null; // { state, txIndex } derived from this.chain
    if (dataFile) this.load();
  }

  // The GENESIS block is hardcoded: it has no parent and no proof of work.
  // Every node builds the identical block, so they all share the same root.
  static createGenesisBlock(config = DEFAULT_CONFIG) {
    return new Block({
      index: 0,
      timestamp: config.GENESIS_TIMESTAMP,
      transactions: [],
      previousHash: '0'.repeat(64),
      nonce: 0,
      difficulty: config.INITIAL_DIFFICULTY,
    });
  }

  get latestBlock() {
    return this.chain[this.chain.length - 1];
  }

  // ---------------------------------------------------------------- state ---

  // Replaying the whole chain on every request would be slow, so the result
  // is cached and only rebuilt when the chain is replaced.
  _derived() {
    if (!this._cache) {
      const state = new Map();
      const txIndex = new Map(); // tx hash -> block index
      for (const block of this.chain) {
        for (const tx of block.transactions) {
          applyTransaction(state, tx);
          txIndex.set(tx.hash, block.index);
        }
      }
      this._cache = { state, txIndex };
    }
    return this._cache;
  }

  // Confirmed balance and nonce (only mined transactions count).
  getAccount(address) {
    return { ...accountOf(this._derived().state, address) };
  }

  // What the account will look like after its pending transactions are mined.
  // New transactions are checked against this, so a user can queue nonce 0,1,2
  // but cannot spend the same coins twice while they wait in the mempool.
  getPendingAccount(address) {
    const account = this.getAccount(address);
    for (const tx of this.mempool) {
      if (tx.from === address) {
        account.balance -= tx.amount + tx.fee;
        account.nonce += 1;
      }
    }
    return account;
  }

  // -------------------------------------------------------------- mempool ---

  addTransaction(data) {
    const tx = this._admitToMempool(data);
    this.save();
    return tx;
  }

  _admitToMempool(data) {
    const tx = Transaction.from(data);
    // Use the hash of the actual contents, not the claimed one: a tampered tx
    // reusing a known hash must be reported as invalid, not as a duplicate.
    const realHash = tx.calculateHash();
    if (this.mempool.some((t) => t.hash === realHash)) throw new ChainError('transaction is already in the mempool', 'duplicate');
    if (this._derived().txIndex.has(realHash)) throw new ChainError('transaction is already confirmed in a block', 'duplicate');
    if (this.mempool.length >= this.config.MAX_MEMPOOL_SIZE) throw new ChainError('mempool is full, try again later');
    const { valid, error } = validateTransaction(tx, this.getPendingAccount(tx.from));
    if (!valid) throw new ChainError(error);
    this.mempool.push(tx);
    return tx;
  }

  // Re-check a list of transactions against the current chain and keep only
  // the ones that are still valid (used after new blocks or a chain swap).
  _rebuildMempool(candidates) {
    this.mempool = [];
    const ordered = [...candidates].sort((a, b) => a.nonce - b.nonce || a.timestamp - b.timestamp);
    for (const tx of ordered) {
      try { this._admitToMempool(tx); } catch { /* now invalid or already mined: drop it */ }
    }
  }

  // ---------------------------------------------------------------- mining ---

  // Pick transactions for the next block: highest fee first (miners are paid
  // by fees), but a sender's nonces must stay in order (nonce 1 can't come
  // before nonce 0). So we loop until no more transactions fit.
  selectTransactions() {
    const scratch = new Map();
    const account = (addr) => scratch.get(addr) ?? this.getAccount(addr);
    const candidates = [...this.mempool].sort((a, b) => b.fee - a.fee || a.timestamp - b.timestamp);
    const selected = new Set();

    let progress = true;
    while (progress && selected.size < this.config.MAX_TX_PER_BLOCK) {
      progress = false;
      for (const tx of candidates) {
        if (selected.size >= this.config.MAX_TX_PER_BLOCK) break;
        if (selected.has(tx) || !validateTransaction(tx, account(tx.from)).valid) continue;
        const sender = account(tx.from);
        scratch.set(tx.from, { balance: sender.balance - tx.amount - tx.fee, nonce: sender.nonce + 1 });
        const receiver = account(tx.to);
        scratch.set(tx.to, { ...receiver, balance: receiver.balance + tx.amount });
        selected.add(tx);
        progress = true;
      }
    }
    return [...selected];
  }

  minePendingTransactions(minerAddress) {
    if (!isAddress(minerAddress)) throw new ChainError('minerAddress must be a 40-character hex address');

    const transactions = this.selectTransactions();
    const fees = transactions.reduce((sum, tx) => sum + tx.fee, 0);
    const index = this.chain.length;
    const timestamp = Math.max(Date.now(), this.latestBlock.timestamp);
    const coinbase = Transaction.coinbase({ minerAddress, amount: this.config.BLOCK_REWARD + fees, blockIndex: index, timestamp });

    const block = new Block({
      index,
      timestamp,
      transactions: [coinbase, ...transactions],
      previousHash: this.latestBlock.hash,
      difficulty: this.nextDifficulty(),
    });
    const { attempts, timeMs } = block.mine();

    // Our own block goes through the same validation as anyone else's.
    const result = this.addBlock(block);
    if (!result.added) throw new Error(`mined block was rejected: ${result.reason}`);
    return { block, attempts, timeMs };
  }

  // ------------------------------------------------------------ difficulty ---

  // DIFFICULTY ADJUSTMENT: every N blocks, compare how long the last blocks
  // actually took with the target. Too fast -> one more zero; too slow -> one
  // fewer (never below MIN_DIFFICULTY). This keeps block times steady even when
  // more or fewer miners join, just like Bitcoin's 2016-block retarget.
  expectedDifficulty(blocks, nextIndex) {
    const { DIFFICULTY_ADJUSTMENT_INTERVAL: interval, TARGET_BLOCK_TIME_MS: target } = this.config;
    const last = blocks[nextIndex - 1];
    if (nextIndex % interval !== 0) return last.difficulty;

    // Measure the window, skipping genesis (its timestamp is a fixed old date).
    const first = blocks[Math.max(1, nextIndex - interval)];
    const intervals = last.index - first.index;
    if (intervals < 1) return last.difficulty;

    const actual = last.timestamp - first.timestamp;
    const expected = target * intervals;
    let difficulty = last.difficulty;
    if (actual < expected / 2) difficulty += 1;
    else if (actual > expected * 2) difficulty -= 1;
    return Math.min(this.config.MAX_DIFFICULTY, Math.max(this.config.MIN_DIFFICULTY, difficulty));
  }

  nextDifficulty() {
    return this.expectedDifficulty(this.chain, this.chain.length);
  }

  // ------------------------------------------------------------ add blocks ---

  // Append a block to our tip (our own mined block, or one from a peer).
  // Returns { added: true } or { added: false, reason }.
  addBlock(data) {
    let block;
    try { block = Block.from(data); } catch (err) { return { added: false, reason: err.message }; }

    if (this.chain[block.index]?.hash === block.hash) return { added: false, reason: 'known' };
    if (block.index !== this.chain.length || block.previousHash !== this.latestBlock.hash) {
      return { added: false, reason: 'not-linked' };
    }

    const { state, txIndex } = this._derived();
    const newState = new Map(state); // validate on a copy; commit only if valid
    try {
      validateBlock(block, this.latestBlock, newState, txIndex, this.nextDifficulty(), this.config);
    } catch (err) {
      return { added: false, reason: err.message };
    }

    this.chain.push(block);
    for (const tx of block.transactions) txIndex.set(tx.hash, block.index);
    this._cache = { state: newState, txIndex };
    this._rebuildMempool(this.mempool); // drops mined txs and ones that became invalid
    this.save();
    return { added: true };
  }

  // ------------------------------------------------------------ validation ---

  // Check a whole chain from scratch, trusting nothing: genesis, every hash,
  // every link, every proof of work, Merkle root, signature, balance, nonce
  // and coinbase amount.
  isValidChain(chainData) {
    try {
      if (!Array.isArray(chainData) || chainData.length === 0) throw new Error('chain must be a non-empty array');
      const blocks = chainData.map((b) => Block.from(b));

      const genesis = Blockchain.createGenesisBlock(this.config);
      if (JSON.stringify(blocks[0]) !== JSON.stringify(genesis)) throw new Error('genesis block does not match');

      const state = new Map();
      const seen = new Set();
      for (let i = 1; i < blocks.length; i++) {
        validateBlock(blocks[i], blocks[i - 1], state, seen, this.expectedDifficulty(blocks, i), this.config);
        for (const tx of blocks[i].transactions) seen.add(tx.hash);
      }
      return { valid: true, blocks };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  // ------------------------------------------------------------- consensus ---

  // Each extra hex zero means ~16x more hashing on average, so a chain's
  // total work is the sum of 16^difficulty over its blocks.
  static cumulativeWork(chain) {
    return chain.reduce((sum, block) => sum + 16 ** block.difficulty, 0);
  }

  // CONSENSUS ("heaviest chain wins"): adopt a peer's chain only if it is fully
  // valid AND has more cumulative work than ours. Counting work instead of
  // length stops anyone from winning with many cheap, low-difficulty blocks.
  replaceChain(chainData) {
    const result = this.isValidChain(chainData);
    if (!result.valid) return { replaced: false, reason: `invalid chain: ${result.error}` };

    const theirWork = Blockchain.cumulativeWork(result.blocks);
    const ourWork = Blockchain.cumulativeWork(this.chain);
    if (theirWork <= ourWork) {
      return { replaced: false, reason: `received chain has less or equal work (${theirWork} vs our ${ourWork})` };
    }

    const oldChain = this.chain;
    this.chain = result.blocks;
    this._cache = null;

    // Transactions from our abandoned blocks ("orphaned") go back to the
    // mempool, and anything already included in the new chain is dropped.
    const included = this._derived().txIndex;
    const orphaned = oldChain
      .flatMap((block) => block.transactions)
      .filter((tx) => !tx.isCoinbase() && !included.has(tx.hash));
    this._rebuildMempool([...orphaned, ...this.mempool]);

    this.save();
    return { replaced: true, height: this.latestBlock.index, orphanedTxs: orphaned.length };
  }

  // ---------------------------------------------------------------- queries ---

  getBlock(index) {
    return this.chain[index] ?? null;
  }

  findTransaction(hash) {
    const pending = this.mempool.find((tx) => tx.hash === hash);
    if (pending) return { status: 'pending', transaction: pending };

    const blockIndex = this._derived().txIndex.get(hash);
    if (blockIndex === undefined) return null;
    const block = this.chain[blockIndex];
    return {
      status: 'confirmed',
      blockIndex,
      blockHash: block.hash,
      confirmations: this.chain.length - blockIndex,
      transaction: block.transactions.find((tx) => tx.hash === hash),
    };
  }

  getAddressInfo(address) {
    const transactions = [];
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.from === address || tx.to === address) {
          transactions.push({ ...tx.toJSON(), status: 'confirmed', blockIndex: block.index });
        }
      }
    }
    for (const tx of this.mempool) {
      if (tx.from === address || tx.to === address) transactions.push({ ...tx.toJSON(), status: 'pending' });
    }
    const pending = this.getPendingAccount(address);
    return {
      address,
      ...this.getAccount(address),
      pendingBalance: pending.balance,
      nextNonce: pending.nonce,
      transactions: transactions.reverse(), // newest first
    };
  }

  getStats() {
    const recent = this.chain.slice(Math.max(1, this.chain.length - 11));
    const averageBlockTimeMs = recent.length >= 2
      ? Math.round((recent[recent.length - 1].timestamp - recent[0].timestamp) / (recent.length - 1))
      : null;
    return {
      height: this.latestBlock.index,
      latestHash: this.latestBlock.hash,
      difficulty: this.nextDifficulty(),
      averageBlockTimeMs,
      targetBlockTimeMs: this.config.TARGET_BLOCK_TIME_MS,
      adjustmentInterval: this.config.DIFFICULTY_ADJUSTMENT_INTERVAL,
      blockReward: this.config.BLOCK_REWARD,
      mempoolSize: this.mempool.length,
      cumulativeWork: Blockchain.cumulativeWork(this.chain),
    };
  }

  // ----------------------------------------------------------- persistence ---

  // Write to a temp file, then rename: a crash mid-write can't corrupt the file.
  save() {
    if (!this.dataFile) return;
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const tmp = `${this.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ chain: this.chain, mempool: this.mempool }, null, 2));
    renameSync(tmp, this.dataFile);
  }

  // A saved file is treated like data from a stranger: fully re-validated.
  load() {
    if (!existsSync(this.dataFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.dataFile, 'utf8'));
      const result = this.isValidChain(data.chain);
      if (!result.valid) throw new Error(result.error);
      this.chain = result.blocks;
      this._cache = null;
      const mempool = [];
      for (const tx of data.mempool ?? []) {
        try { mempool.push(Transaction.from(tx)); } catch { /* skip malformed */ }
      }
      this._rebuildMempool(mempool);
    } catch (err) {
      console.warn(`[minichain] could not load ${this.dataFile} (${err.message}); starting from genesis`);
    }
  }
}
