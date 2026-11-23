/**
 * HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 /
 * ChaCha20-Poly1305 — the one suite Airlock replies use. Open only (the backend
 * receives replies, it never seals). Key schedule on node:crypto; the AEAD is
 * @noble/ciphers because Bun's node:crypto has no chacha20-poly1305.
 * Cross-checked against Python `cryptography` in tests.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { createHmac, createPrivateKey, createPublicKey, diffieHellman, type KeyObject } from "node:crypto";

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => Buffer.concat(p);
const KEM_ID = 0x0020, KDF_ID = 0x0001, AEAD_ID = 0x0003;
const i2 = (n: number) => Uint8Array.of(n >> 8, n & 255);

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();
const extract = (salt: Uint8Array, ikm: Uint8Array) => hmac(salt.length ? salt : new Uint8Array(32), ikm);
function expand(prk: Uint8Array, info: Uint8Array, len: number): Buffer {
  let t = Buffer.alloc(0);
  const out: Buffer[] = [];
  for (let i = 1; out.reduce((n, b) => n + b.length, 0) < len; i++) {
    t = hmac(prk, cat(t, info, Uint8Array.of(i)));
    out.push(t);
  }
  return cat(...out).subarray(0, len);
}
const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(salt, cat(enc("HPKE-v1"), suite, enc(label), ikm));
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(prk, cat(i2(len), enc("HPKE-v1"), suite, enc(label), info), len);

const KEM_SUITE = cat(enc("KEM"), i2(KEM_ID));
const HPKE_SUITE = cat(enc("HPKE"), i2(KEM_ID), i2(KDF_ID), i2(AEAD_ID));

const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: "jwk" }).x!, "base64url");

/** A raw 32-byte X25519 public key as a KeyObject. */
const publicFromRaw = (raw: Uint8Array) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });

export function open(o: { recipientKey: KeyObject; enc: Uint8Array; ct: Uint8Array; info: Uint8Array }): Buffer {
  if (o.enc.length !== 32) throw new Error("bad encapsulated key");
  const dh = diffieHellman({ privateKey: o.recipientKey, publicKey: publicFromRaw(o.enc) });
  const pkR = rawPublic(createPublicKey(o.recipientKey));
  const kemContext = cat(o.enc, pkR);
  const eaePrk = labeledExtract(KEM_SUITE, new Uint8Array(), "eae_prk", dh);
  const sharedSecret = labeledExpand(KEM_SUITE, eaePrk, "shared_secret", kemContext, 32);

  const none = new Uint8Array();
  const pskIdHash = labeledExtract(HPKE_SUITE, none, "psk_id_hash", none);
  const infoHash = labeledExtract(HPKE_SUITE, none, "info_hash", o.info);
  const ksContext = cat(Uint8Array.of(0), pskIdHash, infoHash); // mode_base
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", none);
  const key = labeledExpand(HPKE_SUITE, secret, "key", ksContext, 32);
  const baseNonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", ksContext, 12);

  if (o.ct.length < 16) throw new Error("ciphertext too short");
  return Buffer.from(chacha20poly1305(key, baseNonce).decrypt(o.ct)); // throws on a wrong key/info
}

/** Test helper only: single-shot seal, same schedule. */
export function seal(o: { recipientPublicRaw: Uint8Array; info: Uint8Array; pt: Uint8Array; ephemeral: { privateKey: KeyObject } }): { enc: Buffer; ct: Buffer } {
  const dh = diffieHellman({ privateKey: o.ephemeral.privateKey, publicKey: publicFromRaw(o.recipientPublicRaw) });
  const enc_ = rawPublic(createPublicKey(o.ephemeral.privateKey));
  const eae = labeledExtract(KEM_SUITE, new Uint8Array(), "eae_prk", dh);
  const ss = labeledExpand(KEM_SUITE, eae, "shared_secret", cat(enc_, o.recipientPublicRaw), 32);
  const none = new Uint8Array();
  const ks = cat(Uint8Array.of(0), labeledExtract(HPKE_SUITE, none, "psk_id_hash", none), labeledExtract(HPKE_SUITE, none, "info_hash", o.info));
  const secret = labeledExtract(HPKE_SUITE, ss, "secret", none);
  const c = chacha20poly1305(labeledExpand(HPKE_SUITE, secret, "key", ks, 32), labeledExpand(HPKE_SUITE, secret, "base_nonce", ks, 12));
  return { enc: enc_, ct: Buffer.from(c.encrypt(o.pt)) };
}

export const privateKeyFromPem = (pem: string) => createPrivateKey(pem);
