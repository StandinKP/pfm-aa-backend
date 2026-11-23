/**
 * Device keys. Two keys, two jobs, never shared:
 *
 *   holder  ECDSA P-256 — signs presentations; its did:key is the holder DID.
 *   reply   ECDH  P-256 — the key the enclave seals the insights to (`replyTo`).
 *
 * Both are generated NON-EXTRACTABLE and persisted as CryptoKey objects in
 * IndexedDB, so the private halves are never serialised by our code and never
 * appear in the plugin-store file or a log. Public JWKs are exported on demand.
 *
 * Limit, stated plainly: non-extractable WebCrypto keys live in the app
 * sandbox, not in hardware. Moving them behind Android Keystore / StrongBox
 * (a small Kotlin Tauri plugin that signs and does ECDH) is the production
 * step; KeyStore below is the seam for it.
 */
import { b64u, sha256, utf8 } from "./bytes";
import type { P256PublicJwk } from "./didkey";

export interface DeviceKeys {
  holder: CryptoKeyPair;
  reply: CryptoKeyPair;
}

export interface KeyStore {
  get(name: string): Promise<CryptoKeyPair | undefined>;
  put(name: string, pair: CryptoKeyPair): Promise<void>;
  clear(): Promise<void>;
}

export function memoryKeyStore(): KeyStore {
  const m = new Map<string, CryptoKeyPair>();
  return {
    get: async (n) => m.get(n),
    put: async (n, p) => void m.set(n, p),
    clear: async () => m.clear(),
  };
}

export function indexedDbKeyStore(dbName = "pfm-device"): KeyStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = f(db.transaction("keys", mode).objectStore("keys"));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (n) => run("readonly", (s) => s.get(n) as IDBRequest<CryptoKeyPair | undefined>),
    put: async (n, p) => void (await run("readwrite", (s) => s.put(p, n))),
    clear: async () => void (await run("readwrite", (s) => s.clear())),
  };
}

export async function loadOrCreateDeviceKeys(store: KeyStore): Promise<DeviceKeys> {
  let holder = await store.get("holder");
  if (!holder) {
    holder = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    await store.put("holder", holder);
  }
  let reply = await store.get("reply");
  if (!reply) {
    reply = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    await store.put("reply", reply);
  }
  return { holder, reply };
}

/** Public half only — `d` can never be present on a non-extractable pair's public key. */
export async function publicJwk(key: CryptoKey): Promise<P256PublicJwk> {
  const j = await crypto.subtle.exportKey("jwk", key);
  return { kty: "EC", crv: "P-256", x: j.x!, y: j.y! };
}

/** RFC 7638 thumbprint — the `kid` the enclave puts in the JWE header. */
export async function thumbprint(jwk: P256PublicJwk): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64u(await sha256(utf8(canonical)));
}
