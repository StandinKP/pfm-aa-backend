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

/** Lifecycle hooks the app threads through a send/resume. All optional. */
export interface SendHooks {
  /** Aborting stops polling promptly; the job itself may still complete on the far side. */
  signal?: AbortSignal;
  /**
   * Called with the reply `output` BEFORE the transport acknowledges it, so the app can
   * persist the sealed reply first. If it throws the reply is not acked (redelivered).
   */
  beforeAck?: (output: string) => Promise<void>;
}

export interface Transport {
  readonly name: string;
  send(job: Job, onEvent?: OnEvent, hooks?: SendHooks): Promise<Reply>;
  /**
   * Re-attach to a job that was already sent (app killed, backgrounded, connection lost).
   * Absent on transports that cannot (the in-process mock): the app then marks the job lost.
   */
  resume?(jobId: string, onEvent?: OnEvent, hooks?: SendHooks): Promise<Reply>;
}

export class TransportError extends Error {
  override name = "TransportError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class CancelledError extends Error {
  override name = "CancelledError";
  constructor() {
    super("cancelled");
  }
}

export class ReplyTimeoutError extends Error {
  override name = "ReplyTimeoutError";
}

/** Attributes are cleartext routing metadata: ids and versions only, never content. */
export const AGENT_ATTRIBUTE = "pfm";
export const SCHEMA_VERSION_ATTRIBUTE = "2";
