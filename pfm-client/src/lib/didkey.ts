/**
 * did:key for a P-256 public key (multicodec p256-pub 0x1200, compressed point,
 * base58btc multibase 'z' → "did:key:zDn…").
 *
 * Encode only. The enclave resolves the holder key from the agent credential's
 * `cnf` (ADR-004 profile), and checks that the presenter's did:key is derived
 * from it — so the app never needs to decode a did:key.
 */
import { b64uDecode, concat } from "./bytes";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btc(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export interface P256PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export function didKeyFromP256Jwk(jwk: P256PublicJwk): string {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("not a P-256 EC key");
  const x = b64uDecode(jwk.x);
  const y = b64uDecode(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error("malformed P-256 coordinates");
  const compressed = concat(new Uint8Array([(y[31]! & 1) === 0 ? 0x02 : 0x03]), x);
  const multicodec = new Uint8Array([0x80, 0x24]); // varint(0x1200)
  return `did:key:z${base58btc(concat(multicodec, compressed))}`;
}
