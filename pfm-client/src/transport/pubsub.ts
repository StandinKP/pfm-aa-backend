/**
 * Transport: the sandbox/preprod Pub/Sub queue, straight from the device.
 *
 * Both legs are outbound from the phone — publish the encrypted job, then poll
 * the reply subscription. Nothing connects to the TEE; nothing can.
 *
 * Reply handling honours shared ownership of the reply subscription: a pull may
 * surface other jobs' replies, so only our jobId is acked and everything else is
 * surrendered back (modAck 0). Duplicates of our own reply (at-least-once) are
 * absorbed by taking the first.
 *
 * The access token is supplied by the caller and held in memory only. It is a
 * DEVELOPMENT affordance — see README: a phone should not be the queue
 * requester identity in production.
 */
import type { PubSubClient } from "./pubsubClient";
import type { QueueCrypto, Envelope } from "./envelope";
import type { ResourceNames } from "./names";
import { AGENT_ATTRIBUTE, CancelledError, ReplyTimeoutError, SCHEMA_VERSION_ATTRIBUTE, type Job, type OnEvent, type Reply, type SendHooks, type Transport } from "./types";
import { sleep, withRetry } from "../lib/retry";
import { fromUtf8, utf8 } from "../lib/bytes";

export function createPubSubTransport(o: {
  names: ResourceNames;
  pubsub: PubSubClient;
  crypto: QueueCrypto;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Transport {
  return {
    name: `pubsub:${o.names.env}/${o.names.partner}`,

    async send(job: Job, onEvent?: OnEvent, hooks?: SendHooks): Promise<Reply> {
      const say = onEvent ?? (() => undefined);
      const started = Date.now();

      const envelope = await o.crypto.encryptRequest(utf8(JSON.stringify(job.body)));
      say("request encrypted under the slot's request key");

      await o.pubsub.publish(o.names.requestTopic, utf8(JSON.stringify(envelope)), {
        jobId: job.jobId,
        agent: AGENT_ATTRIBUTE,
        schemaVersion: SCHEMA_VERSION_ATTRIBUTE,
      });
      say("published; waiting for the attested enclave to pull it");
      return awaitReply(job.jobId, started, say, hooks);
    },

    /** Re-attach by jobId: the reply stays on the subscription until it is acked. */
    resume(jobId: string, onEvent?: OnEvent, hooks?: SendHooks): Promise<Reply> {
      const say = onEvent ?? (() => undefined);
      say("re-attaching to the queue for an earlier job");
      return awaitReply(jobId, Date.now(), say, hooks);
    },
  };

  async function awaitReply(jobId: string, started: number, say: OnEvent, hooks?: SendHooks): Promise<Reply> {
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      if (hooks?.signal?.aborted) throw new CancelledError();
      const batch = await withRetry(() => o.pubsub.pull(o.names.replySubscription, 20), { signal: hooks?.signal, tries: 3 });
      const others = batch.filter((m) => m.attributes["jobId"] !== jobId);
      const mine = batch.filter((m) => m.attributes["jobId"] === jobId);
      if (others.length) await o.pubsub.modAck(o.names.replySubscription, others.map((m) => m.ackId), 0);

      if (mine.length) {
        const reply = mine[0]!;
        const ackAll = () => o.pubsub.ack(o.names.replySubscription, mine.map((m) => m.ackId));
        if (reply.attributes["outcome"] !== "ok") {
          await ackAll();
          return { outcome: "error", errorType: reply.attributes["errorType"] ?? "UnknownError" };
        }
        try {
          const env = JSON.parse(fromUtf8(reply.data)) as Envelope;
          const body = JSON.parse(fromUtf8(await o.crypto.decryptReply(env))) as { output?: unknown };
          if (typeof body.output !== "string") {
            await ackAll();
            return { outcome: "error", errorType: "ReplyShapeError" };
          }
          // Persist first, ack second: a crash in between redelivers instead of losing the reply.
          await hooks?.beforeAck?.(body.output);
          await ackAll();
          say(`reply received after ${Math.round((Date.now() - started) / 1000)}s`);
          return { outcome: "ok", output: body.output };
        } catch (e) {
          // Could not read or persist it: hand it back to the queue rather than destroy it.
          await o.pubsub.modAck(o.names.replySubscription, mine.map((m) => m.ackId), 0).catch(() => undefined);
          throw e;
        }
      }
      await sleep(o.pollIntervalMs ?? 3_000, hooks?.signal);
    }
    throw new ReplyTimeoutError(
      "no reply in time — is the slot's workload attested and running an image that accepts schema-2 jobs? (scripts/verify-attestation.sh, scripts/verify-pubsub.sh)",
    );
  }
}
