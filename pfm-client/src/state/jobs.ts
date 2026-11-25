/**
 * The persisted job record. Written BEFORE a job is sent so a restart / background kill can
 * re-attach by jobId instead of orphaning it. It holds ids, status and — once received — the
 * SEALED reply (ciphertext only). Plaintext never lands here.
 *
 *   sent ──► replied ──► applied
 *     │         └── (reply persisted before the transport acks it; applied = merged into the ledger)
 *     ├──► failed     (enclave refusal: final)
 *     ├──► cancelled  (user)
 *     └──► lost       (cannot be re-attached: in-process mock, or the far side forgot it)
 */
import type { KV } from "../lib/storage";

export type JobStatus = "sent" | "replied" | "applied" | "failed" | "cancelled" | "lost";

export interface JobRecord {
  jobId: string;
  mode: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  /** The reply `output` string (contains the JWE). Present from `replied` on, until `applied`. */
  sealedReply?: string;
  error?: string;
}

const KEY = "job";

export const loadJob = (kv: KV) => kv.get<JobRecord>(KEY);
export const saveJob = (kv: KV, j: JobRecord) => kv.set(KEY, j);

export const isPending = (j: JobRecord | undefined): j is JobRecord => !!j && (j.status === "sent" || j.status === "replied");
