/**
 * Small key/value persistence for NON-SECRET things: configuration, the
 * imported credential bundle (synthetic in sandbox) and the latest SEALED
 * reply. Plaintext insights and private keys are never written here.
 *
 * Inside Tauri this is the app-private plugin-store file; in a plain browser
 * (`bun run dev`, no phone needed) it falls back to localStorage.
 */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const inTauri = (): boolean => typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";

export async function openKV(): Promise<KV> {
  if (inTauri()) {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("pfm.json", { autoSave: true, defaults: {} });
    return {
      get: async <T>(k: string) => (await store.get<T>(k)) ?? undefined,
      set: async (k, v) => store.set(k, v),
      delete: async (k) => void (await store.delete(k)),
    };
  }
  const ls = (): Storage | undefined => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  };
  return {
    get: async <T>(k: string) => {
      const raw = ls()?.getItem(`pfm.${k}`);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    },
    set: async (k, v) => void ls()?.setItem(`pfm.${k}`, JSON.stringify(v)),
    delete: async (k) => void ls()?.removeItem(`pfm.${k}`),
  };
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => void m.set(k, JSON.parse(JSON.stringify(v))),
    delete: async (k) => void m.delete(k),
  };
}
