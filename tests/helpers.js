import { Blockchain } from '../src/blockchain.js';
import { Transaction } from '../src/transaction.js';

// Low difficulty keeps the test suite fast; the rules are identical.
export const FAST_CONFIG = { INITIAL_DIFFICULTY: 1, MIN_DIFFICULTY: 1 };

export function newChain(config = {}) {
  return new Blockchain({ config: { ...FAST_CONFIG, ...config } });
}

export function mineBlocks(chain, minerAddress, count = 1) {
  for (let i = 0; i < count; i++) chain.minePendingTransactions(minerAddress);
}

export function pay(chain, wallet, to, amount, fee = 0) {
  const { nonce } = chain.getPendingAccount(wallet.address);
  return chain.addTransaction(Transaction.create({ wallet, to, amount, fee, nonce }));
}

// Deep copy through JSON, exactly what a chain looks like after the network.
export const clone = (value) => JSON.parse(JSON.stringify(value));
