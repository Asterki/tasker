/**
 * Sync-key derivation for the MCP endpoint.
 *
 * Mirrors `src/sync/crypto.ts` exactly: the same passphrase a device uses must
 * produce the same authentication key, encryption key and workspace
 * fingerprint. The passphrase itself is never persisted; only derived keys are
 * cached in memory for a short while.
 */

import { createHash, webcrypto } from 'node:crypto';

const encoder = new TextEncoder();
const ITERATIONS = 600_000;
const SALT = encoder.encode('tasker-sync-v1');
const KEY_CACHE_MS = 30 * 60 * 1000;
const KEY_CACHE_MAX = 8;

export interface SyncKeys {
  authKey: string;
  encKey: CryptoKey;
  fingerprint: string;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export async function deriveKeys(passphrase: string): Promise<SyncKeys> {
  const normalized = passphrase.normalize('NFKC');
  const base = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(normalized),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const masterBits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    256,
  );

  const hkdf = await webcrypto.subtle.importKey('raw', masterBits, 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);

  const authBits = await webcrypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('tasker-auth') },
    hkdf,
    256,
  );

  const encKey = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('tasker-enc') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  const authKey = toBase64Url(new Uint8Array(authBits));
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', encoder.encode(authKey)));

  return {
    authKey,
    encKey,
    fingerprint: Array.from(digest.slice(0, 4), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

const keyCache = new Map<string, { keys: SyncKeys; expiresAt: number }>();

/** Derives (or reuses) the keys for a passphrase. PBKDF2 is deliberately slow. */
export async function keysFor(passphrase: string): Promise<SyncKeys> {
  const cacheKey = createHash('sha256').update(passphrase).digest('hex');
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const keys = await deriveKeys(passphrase);
  keyCache.set(cacheKey, { keys, expiresAt: Date.now() + KEY_CACHE_MS });

  for (const [key, entry] of keyCache) {
    if (entry.expiresAt <= Date.now() || keyCache.size > KEY_CACHE_MAX) keyCache.delete(key);
  }
  return keys;
}

export function authKeyHash(authKey: string): string {
  return createHash('sha256').update(authKey).digest('hex');
}

export async function encryptPayload(value: unknown, key: CryptoKey): Promise<string> {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(value));
  const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

export async function decryptPayload<T>(value: string, key: CryptoKey): Promise<T> {
  const [ivPart, cipherPart] = value.split('.');
  if (!ivPart || !cipherPart) throw new Error('Malformed sync payload');

  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(ivPart) },
    key,
    fromBase64Url(cipherPart),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
