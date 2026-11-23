/**
 * The queue envelope — byte-compatible with partner-kit/ENVIRONMENT.md and the
 * platform requester (requester/src/envelope.ts):
 *
 *   body = JSON { wrappedDek: b64(KMS-encrypt(DEK)), ciphertext: b64(IV‖CT‖TAG) }
 *   DEK 32 bytes, single use · AES-256-GCM · IV 12 · TAG 16 · no AAD
 *
 * WebCrypto's AES-GCM output is already CT‖TAG, so IV‖output is the wire layout.
 * Direction-scoped keys: this side ENCRYPTS under the request KEK and DECRYPTS
 * under the reply KEK, and holds no other grant on either.
 */
import { b64, b64Decode, concat } from "../lib/bytes";
import { TransportError } from "./types";

export interface Envelope {
  wrappedDek: string;
  ciphertext: string;
}

export type KmsCall = (path: string, body: Record<string, string>) => Promise<Record<string, unknown>>;

export function createKmsCall(token: () => Promise<string>, fetchImpl: typeof fetch = fetch): KmsCall {
  return async (path, body) => {
    const res = await fetchImpl(`https://cloudkms.googleapis.com/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new TransportError(
        `cloudkms returned ${res.status}` + (res.status === 403 ? " — this identity is not the slot's queue requester" : ""),
      );
    }
    return (await res.json()) as Record<string, unknown>;
  };
}

const IV = 12;
const aes = (dek: Uint8Array, usage: KeyUsage) =>
  crypto.subtle.importKey("raw", dek as BufferSource, "AES-GCM", false, [usage]);

export interface QueueCrypto {
  encryptRequest(plaintext: Uint8Array): Promise<Envelope>;
  decryptReply(env: Envelope): Promise<Uint8Array>;
}

export function createQueueCrypto(o: { requestKek: string; replyKek: string; kms: KmsCall }): QueueCrypto {
  return {
    async encryptRequest(plaintext) {
      const dek = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(IV));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 }, await aes(dek, "encrypt"), plaintext as BufferSource));
      const resp = await o.kms(`${o.requestKek}:encrypt`, { plaintext: b64(dek) });
      dek.fill(0);
      if (typeof resp["ciphertext"] !== "string") throw new TransportError("KMS returned no ciphertext");
      return { wrappedDek: resp["ciphertext"], ciphertext: b64(concat(iv, ct)) };
    },

    async decryptReply(env) {
      const resp = await o.kms(`${o.replyKek}:decrypt`, { ciphertext: env.wrappedDek });
      if (typeof resp["plaintext"] !== "string") throw new TransportError("KMS returned no plaintext");
      const dek = b64Decode(resp["plaintext"]);
      try {
        const blob = b64Decode(env.ciphertext);
        if (blob.length < IV + 16) throw new TransportError("ciphertext too short");
        return new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: blob.subarray(0, IV) as BufferSource, tagLength: 128 },
            await aes(dek, "decrypt"),
            blob.subarray(IV) as BufferSource,
          ),
        );
      } finally {
        dek.fill(0);
      }
    },
  };
}
