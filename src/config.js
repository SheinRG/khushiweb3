// The "rules of the game" for MiniChain.
// Every node must use the same values: if two nodes disagree on, say, the
// block reward, they will reject each other's blocks. Rules that all nodes
// must share are called CONSENSUS RULES.
export const DEFAULT_CONFIG = Object.freeze({
  // New coins created for the miner of each block (like Bitcoin's block subsidy).
  BLOCK_REWARD: 50,

  // Max user transactions per block (the coinbase is extra). Limited block
  // space is why users compete with fees.
  MAX_TX_PER_BLOCK: 10,

  // Difficulty = number of leading hex zeros a block hash needs.
  // Each extra zero makes mining ~16x harder.
  INITIAL_DIFFICULTY: 3,
  MIN_DIFFICULTY: 1,
  MAX_DIFFICULTY: 5, // a cap so mining in Node never freezes the laptop

  // Difficulty adjustment: every N blocks, compare real block times to the target.
  TARGET_BLOCK_TIME_MS: 10_000,
  DIFFICULTY_ADJUSTMENT_INTERVAL: 10,

  // Blocks claiming to be from the far future are rejected.
  MAX_FUTURE_DRIFT_MS: 2 * 60 * 1000,

  // Protects a node's memory from being flooded with pending transactions.
  MAX_MEMPOOL_SIZE: 1000,

  // Fixed so every node builds exactly the same genesis block.
  GENESIS_TIMESTAMP: Date.UTC(2024, 0, 1),
});
