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
import { AGENT_ATTRIBUTE, ReplyTimeoutError, SCHEMA_VERSION_ATTRIBUTE, type Job, type OnEvent, type Reply, type Transport } from "./types";
import { fromUtf8, utf8 } from "../lib/bytes";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createPubSubTransport(o: {
  names: ResourceNames;
  pubsub: PubSubClient;
  crypto: QueueCrypto;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Transport {
  return {
    name: `pubsub:${o.names.env}/${o.names.partner}`,

    async send(job: Job, onEvent?: OnEvent): Promise<Reply> {
      const say = onEvent ?? (() => undefined);
      const started = Date.now();
      const deadline = started + (o.timeoutMs ?? 120_000);

      const envelope = await o.crypto.encryptRequest(utf8(JSON.stringify(job.body)));
      say("request encrypted under the slot's request key");

      await o.pubsub.publish(o.names.requestTopic, utf8(JSON.stringify(envelope)), {
        jobId: job.jobId,
        agent: AGENT_ATTRIBUTE,
        schemaVersion: SCHEMA_VERSION_ATTRIBUTE,
      });
      say("published; waiting for the attested enclave to pull it");

      while (Date.now() < deadline) {
        const batch = await o.pubsub.pull(o.names.replySubscription, 20);
        const others = batch.filter((m) => m.attributes["jobId"] !== job.jobId);
        const mine = batch.filter((m) => m.attributes["jobId"] === job.jobId);
        if (others.length) await o.pubsub.modAck(o.names.replySubscription, others.map((m) => m.ackId), 0);

        if (mine.length) {
          await o.pubsub.ack(o.names.replySubscription, mine.map((m) => m.ackId));
          const reply = mine[0]!;
          if (reply.attributes["outcome"] !== "ok") {
            return { outcome: "error", errorType: reply.attributes["errorType"] ?? "UnknownError" };
          }
          const env = JSON.parse(fromUtf8(reply.data)) as Envelope;
          const body = JSON.parse(fromUtf8(await o.crypto.decryptReply(env))) as { output?: unknown };
          say(`reply received after ${Math.round((Date.now() - started) / 1000)}s`);
          if (typeof body.output !== "string") return { outcome: "error", errorType: "ReplyShapeError" };
          return { outcome: "ok", output: body.output };
        }
        await sleep(o.pollIntervalMs ?? 3_000);
      }
      throw new ReplyTimeoutError(
        "no reply in time — is the slot's workload attested and running an image that accepts schema-2 jobs? (scripts/verify-attestation.sh, scripts/verify-pubsub.sh)",
      );
    },
  };
}
