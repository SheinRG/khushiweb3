// An expected, user-facing rule violation (bad signature, low balance, ...).
// The HTTP layer turns these into 4xx responses instead of 500s.
export class ChainError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'ChainError';
    this.code = code; // 'invalid' | 'duplicate' | 'not-found'
  }
}
