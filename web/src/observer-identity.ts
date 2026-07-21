/**
 * Device observer identity (docs/observability.md §3, browser side).
 *
 * On first use the SPA generates a NON-EXTRACTABLE Ed25519 keypair via
 * WebCrypto and persists the CryptoKey objects in IndexedDB — the private
 * key never exists as bytes the page (or an XSS) could read. The public
 * fingerprint (`ed25519:<base64url raw>`) is what a human shows to the
 * agent/operator to be granted (`observers--grant`).
 *
 * Requires a secure context (https or localhost) — WebCrypto is absent on
 * plain-http non-localhost origins. Callers get `null` and should offer
 * password sign-in instead.
 */

const DB_NAME = 'fkm-observer';
const STORE = 'keys';
const KEY_ID = 'device-key';

interface DeviceKey {
  keyPair: CryptoKeyPair;
  /** `ed25519:<base64url raw 32-byte public key>` */
  id: string;
}

function b64url(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolvePromise, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolvePromise(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolvePromise, reject) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    tx.onsuccess = () => resolvePromise(tx.result as T | undefined);
    tx.onerror = () => reject(tx.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolvePromise();
    tx.onerror = () => reject(tx.error);
  });
}

async function fingerprintOf(publicKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  return `ed25519:${b64url(raw)}`;
}

/** Ed25519 support probe — false on insecure contexts and old browsers. */
export function observerCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined';
}

/** Load (or create on first use) this device's observer key. Null when the
 *  environment can't do WebCrypto Ed25519. */
export async function ensureDeviceKey(): Promise<DeviceKey | null> {
  if (!observerCryptoAvailable()) return null;
  try {
    const db = await idb();
    const existing = await idbGet<CryptoKeyPair>(db, KEY_ID);
    if (existing?.privateKey && existing.publicKey) {
      return { keyPair: existing, id: await fingerprintOf(existing.publicKey) };
    }
    const keyPair = (await crypto.subtle.generateKey(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      false, // non-extractable — the private key never leaves the browser
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    await idbPut(db, KEY_ID, keyPair);
    return { keyPair, id: await fingerprintOf(keyPair.publicKey) };
  } catch (err) {
    console.warn('[observer] device key unavailable:', err);
    return null;
  }
}

/** Build the signed observer-hello identity envelope for `host` (the value
 *  the server sent in observer-auth-required — its own Host header). */
export async function buildHelloIdentity(host: string): Promise<{
  scheme: 'ed25519'; id: string; proof: string; timestamp: string;
} | null> {
  const key = await ensureDeviceKey();
  if (!key) return null;
  const timestamp = new Date().toISOString();
  const statement = `connectome-observer|v1|${host}|${timestamp}`;
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' } as AlgorithmIdentifier,
    key.keyPair.privateKey,
    new TextEncoder().encode(statement),
  );
  return { scheme: 'ed25519', id: key.id, proof: b64url(sig), timestamp };
}

/** Current device fingerprint for display (creates the key if absent). */
export async function deviceFingerprint(): Promise<string | null> {
  const key = await ensureDeviceKey();
  return key?.id ?? null;
}
