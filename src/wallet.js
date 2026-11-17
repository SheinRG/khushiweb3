import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as ecdsaSign,
  verify as ecdsaVerify,
} from 'node:crypto';
import { sha256, isHex } from './crypto-utils.js';

// A wallet is just a key pair. There is no "account signup" on a blockchain:
//   private key -> kept secret, used to SIGN transactions (proves ownership)
//   public key  -> shared, lets anyone VERIFY those signatures
//   address     -> a short hash of the public key, used like an account number

// secp256k1 is the curve Bitcoin and Ethereum use. prime256v1 (a.k.a. P-256)
// is accepted too because it is the only one browsers' Web Crypto can sign
// with. Public keys are stored in SPKI format, which records its own curve,
// so verification works for both without any special casing.
const SUPPORTED_CURVES = new Set(['secp256k1', 'prime256v1']);

// Signatures are stored as raw r||s bytes (64 bytes) — the format Web Crypto
// produces — instead of Node's default DER encoding.
const SIGNATURE_ENCODING = 'ieee-p1363';

export function generateWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  return {
    address: addressFromPublicKey(publicKeyHex),
    publicKey: publicKeyHex,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    curve: 'secp256k1',
  };
}

// Address = first 40 hex chars (20 bytes) of sha256(public key bytes).
// Shorter than a public key, and hides the key until its first spend.
export function addressFromPublicKey(publicKeyHex) {
  return sha256(Buffer.from(publicKeyHex, 'hex')).slice(0, 40);
}

// ECDSA: sha256(data) is signed with the private key.
export function sign(data, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  return ecdsaSign('sha256', Buffer.from(data), { key, dsaEncoding: SIGNATURE_ENCODING }).toString('hex');
}

// Anyone can check a signature with only the public key. Returns true/false
// and never throws, so garbage input simply counts as an invalid signature.
export function verify(data, signatureHex, publicKeyHex) {
  if (!isHex(signatureHex) || !isHex(publicKeyHex)) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || !SUPPORTED_CURVES.has(key.asymmetricKeyDetails?.namedCurve)) return false;
    return ecdsaVerify(
      'sha256',
      Buffer.from(data),
      { key, dsaEncoding: SIGNATURE_ENCODING },
      Buffer.from(signatureHex, 'hex'),
    );
  } catch {
    return false;
  }
}
