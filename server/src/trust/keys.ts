import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { calculateJwkThumbprint, importJWK, importPKCS8, type JWK } from 'jose';

/**
 * Key identity. Every principal and agent is an Ed25519 key pair (RFC 8037 OKP keys). Identifiers are
 * did:key strings (Ed25519 multicodec 0xed01, base58btc), and keys are compared by RFC 7638 thumbprint.
 * Nothing here is novel cryptography: Node's crypto and the jose library do the work.
 */
export type PublicJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string };
export type KeyPair = { publicJwk: PublicJwk; privatePem: string };

export function newKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as any;
  return { publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** Accepts only a public Ed25519 JWK. Anything carrying private material or another key type is rejected. */
export function parsePublicJwk(input: unknown): PublicJwk {
  const j = input as any;
  if (!j || typeof j !== 'object' || j.kty !== 'OKP' || j.crv !== 'Ed25519' || typeof j.x !== 'string' || 'd' in j) throw new Error('Expected a public Ed25519 JWK (kty OKP, crv Ed25519).');
  const raw = Buffer.from(j.x, 'base64url');
  if (raw.length !== 32) throw new Error('The Ed25519 public key must be 32 bytes.');
  return { kty: 'OKP', crv: 'Ed25519', x: j.x };
}

export const publicJwkOfPem = (privatePem: string): PublicJwk => {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: 'jwk' }) as any;
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
};
export const thumbprint = (jwk: PublicJwk) => calculateJwkThumbprint(jwk as JWK, 'sha256');
export const verifyKey = (jwk: PublicJwk) => importJWK(jwk as JWK, 'EdDSA');
export const signingKey = (privatePem: string) => importPKCS8(privatePem, 'EdDSA');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btc(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`), out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
/** did:key for an Ed25519 public key, as defined by the did:key method (multicodec ed25519-pub, base58btc). */
export function didKey(jwk: PublicJwk): string {
  const raw = Buffer.from(jwk.x, 'base64url');
  return `did:key:z${base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
}
