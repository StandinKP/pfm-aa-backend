/**
 * The seam between "what the app says" and "how it reaches the enclave".
 *
 * Every transport carries the SAME job (the VP is inside the body) and returns
 * the SAME reply shape, so moving from the mock to the sandbox queue to an FIU
 * backend relay changes one constructor call, not the app.
 */
export interface Job {
  jobId: string;
  /** Plaintext request body, `vp` included. Transports encrypt it; they never read it. */
  body: Record<string, unknown>;
}

export type Reply =
  | { outcome: "ok"; /** the reply body's `output` string */ output: string }
  /** `errorType` is the only failure detail the wire carries — a type, never a message. */
  | { outcome: "error"; errorType: string };

export type OnEvent = (line: string) => void;

export interface Transport {
  readonly name: string;
  send(job: Job, onEvent?: OnEvent): Promise<Reply>;
}

export class TransportError extends Error {
  override name = "TransportError";
}

export class ReplyTimeoutError extends Error {
  override name = "ReplyTimeoutError";
}

/** Attributes are cleartext routing metadata: ids and versions only, never content. */
export const AGENT_ATTRIBUTE = "pfm";
export const SCHEMA_VERSION_ATTRIBUTE = "2";
