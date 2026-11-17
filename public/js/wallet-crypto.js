// Browser-side wallet: keys are generated and transactions are signed HERE,
// in your browser. The node only ever receives the signed transaction.
//
// Why P-256 and not secp256k1? Web Crypto (built into every browser) only
// supports the NIST curves P-256/P-384/P-521 for ECDSA. Rather than ship
// hand-written elliptic-curve math, MiniChain lets browser wallets use P-256.
// Public keys travel in SPKI format, which names its curve, so the server
// verifies both curves with the same code.
//
// This file uses only standard Web APIs (crypto.subtle, TextEncoder), so the
// Node test suite imports it too and proves the server accepts its signatures.

const subtle = globalThis.crypto.subtle;
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' };

export const toHex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  return new Uint8Array(hex.match(/../g).map((byte) => parseInt(byte, 16)));
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return toHex(await subtle.digest('SHA-256', bytes));
}

// Must produce exactly the same string as src/crypto-utils.js on the server,
// otherwise browser and server would compute different transaction hashes.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Address = first 40 hex chars of sha256(public key bytes), same as the server.
export async function addressFromPublicKey(publicKeyHex) {
  return (await sha256Hex(fromHex(publicKeyHex))).slice(0, 40);
}

export async function createBrowserWallet(label = 'Wallet') {
  const keyPair = await subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const publicKey = toHex(await subtle.exportKey('spki', keyPair.publicKey));
  const privateJwk = await subtle.exportKey('jwk', keyPair.privateKey);
  return {
    label,
    address: await addressFromPublicKey(publicKey),
    publicKey,
    privateJwk, // DEMO ONLY: stored in localStorage, readable by any script on this page
    curve: 'P-256',
    createdAt: Date.now(),
  };
}

// Build, hash and sign a transaction. Signs the UTF-8 bytes of the hash hex
// string with ECDSA-SHA256; Web Crypto outputs raw r||s, which the server
// reads with dsaEncoding 'ieee-p1363'.
export async function createSignedTransaction(wallet, { to, amount, fee, nonce, timestamp = Date.now() }) {
  const payload = { from: wallet.address, to, amount, fee, nonce, timestamp, publicKey: wallet.publicKey };
  const hash = await sha256Hex(stableStringify(payload));
  const privateKey = await subtle.importKey('jwk', wallet.privateJwk, ALGORITHM, false, ['sign']);
  const signature = toHex(await subtle.sign(SIGN_PARAMS, privateKey, new TextEncoder().encode(hash)));
  return { ...payload, hash, signature };
}
