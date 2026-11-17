import { createHash } from 'node:crypto';

// SHA-256 turns any data into a 64-hex-char "fingerprint".
// Change one bit of input and the output changes completely, and nobody can
// find an input for a given output. Blockchains use it to link and seal data.
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// JSON.stringify keeps keys in insertion order, so {a:1,b:2} and {b:2,a:1}
// would produce different hashes. Sorting the keys makes the serialization
// DETERMINISTIC: the same data always gives the same bytes on every node.
// (public/js/wallet-crypto.js has an identical copy for the browser.)
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function isHex(value, length) {
  return typeof value === 'string'
    && value.length > 0
    && value.length % 2 === 0
    && /^[0-9a-f]+$/.test(value)
    && (length === undefined || value.length === length);
}

export const ADDRESS_LENGTH = 40;

export function isAddress(value) {
  return isHex(value, ADDRESS_LENGTH);
}

export const shortHash = (hash) => (typeof hash === 'string' ? `${hash.slice(0, 10)}…` : String(hash));
