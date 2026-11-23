/**
 * RFC 8785 JSON Canonicalization Scheme — vendored from the platform's
 * issuer/src/jcs.ts (same algorithm, Uint8Array instead of Buffer).
 *
 * `payloadDigest` in a presentation is SHA-256 over this output, and the
 * enclave recomputes it, so the two sides must agree byte for byte. The
 * parity test (tests/vc.test.ts) reproduces the platform corpus digest.
 *
 * Do not "fix" the key sort: no comparator is correct (UTF-16 code unit order,
 * RFC 8785 §3.2.3). `undefined` object members are dropped, as in JSON.stringify.
 * NaN/Infinity throw: emitting null would let two payloads share a digest.
 */
import { utf8 } from "./bytes";

export class JcsError extends Error {
  override name = "JcsError";
}

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new JcsError(`${String(value)} has no JSON representation`);
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new JcsError(`${typeof value} is not serializable as JSON`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
  }
  return `{${parts.join(",")}}`;
}

export const canonicalBytes = (value: unknown): Uint8Array => utf8(canonicalize(value));
