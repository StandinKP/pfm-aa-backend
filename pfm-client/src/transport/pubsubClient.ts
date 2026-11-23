/**
 * Pub/Sub REST, requester side — publish requests, pull replies. No SDK: a
 * handful of POSTs, same as the platform requester. This half holds no
 * subscriber grant on the intake subscription and no publisher grant on the
 * reply topic; if either ever succeeds, the platform's direction IAM is broken.
 */
import { b64, b64Decode } from "../lib/bytes";
import { TransportError } from "./types";

export interface ReplyMessage {
  ackId: string;
  messageId: string;
  attributes: Record<string, string>;
  data: Uint8Array;
}

export interface PubSubClient {
  publish(topic: string, data: Uint8Array, attributes: Record<string, string>): Promise<string>;
  pull(subscription: string, max: number): Promise<ReplyMessage[]>;
  ack(subscription: string, ackIds: string[]): Promise<void>;
  /** deadline 0 returns the message to the queue for its owner. */
  modAck(subscription: string, ackIds: string[], seconds: number): Promise<void>;
}

export function createPubSubClient(token: () => Promise<string>, fetchImpl: typeof fetch = fetch): PubSubClient {
  const call = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`https://pubsub.googleapis.com/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new TransportError(`pubsub returned ${res.status}` + (res.status === 403 ? " — this identity is not the slot's queue requester" : ""));
    }
    return (await res.json()) as Record<string, unknown>;
  };

  return {
    async publish(topic, data, attributes) {
      const r = await call(`${topic}:publish`, { messages: [{ data: b64(data), attributes }] });
      const ids = r["messageIds"];
      if (!Array.isArray(ids) || typeof ids[0] !== "string") throw new TransportError("publish returned no messageId");
      return ids[0];
    },
    async pull(subscription, max) {
      let r: Record<string, unknown>;
      try {
        r = await call(`${subscription}:pull`, { maxMessages: max });
      } catch (e) {
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return []; // idle long-poll
        throw e;
      }
      const received = r["receivedMessages"];
      if (!Array.isArray(received)) return [];
      const out: ReplyMessage[] = [];
      for (const item of received) {
        const m = item as { ackId?: string; message?: { data?: string; messageId?: string; attributes?: Record<string, string> } };
        if (!m.ackId || !m.message?.messageId) continue;
        out.push({ ackId: m.ackId, messageId: m.message.messageId, attributes: m.message.attributes ?? {}, data: b64Decode(m.message.data ?? "") });
      }
      return out;
    },
    async ack(subscription, ackIds) {
      if (ackIds.length) await call(`${subscription}:acknowledge`, { ackIds });
    },
    async modAck(subscription, ackIds, seconds) {
      if (ackIds.length) await call(`${subscription}:modifyAckDeadline`, { ackIds, ackDeadlineSeconds: seconds });
    },
  };
}
