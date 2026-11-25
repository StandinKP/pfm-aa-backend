/**
 * Seals app data to the device's OWN reply key, so the ledger (transactions, narrations)
 * is never written to disk in plaintext: only a compact JWE (ECDH-ES / A256GCM) that this
 * device's non-extractable reply private key can open. Same primitive the enclave uses for
 * the reply, so there is no new key type to protect.
 *
 * Consequence (by design): "Forget this device" deletes the keys and everything sealed to them.
 */
import { CompactEncrypt, compactDecrypt, importJWK, type JWK } from "jose";
import { fromUtf8, utf8 } from "../lib/bytes";
import { publicJwk, thumbprint, type DeviceKeys } from "../lib/keys";

export async function sealJson(value: unknown, keys: DeviceKeys): Promise<string> {
  const jwk = await publicJwk(keys.reply.publicKey);
  return new CompactEncrypt(utf8(JSON.stringify(value)))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", kid: await thumbprint(jwk), cty: "application/json" })
    .encrypt(await importJWK(jwk as JWK, "ECDH-ES"));
}

export async function openJson<T>(jwe: string, keys: DeviceKeys): Promise<T> {
  const { plaintext } = await compactDecrypt(jwe, keys.reply.privateKey);
  return JSON.parse(fromUtf8(plaintext)) as T;
}
