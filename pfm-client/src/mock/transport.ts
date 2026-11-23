/**
 * Transport: in-process mock enclave. Runs identically in a browser tab and on
 * the phone with no network, so the whole request → verify → fetch → seal →
 * unseal → render path can be exercised today. Refusals come back exactly as
 * the wire carries them: an `errorType` and nothing else.
 */
import type { Job, OnEvent, Reply, Transport } from "../transport/types";
import { EnclaveRefusal, processJob, verifyJob, type MockTrust } from "./enclave";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMockTransport(o: { trust: MockTrust; latencyMs?: number; now?: () => number }): Transport {
  const wait = (ms: number) => (o.latencyMs === 0 ? Promise.resolve() : sleep(o.latencyMs ?? ms));
  return {
    name: "mock-enclave (no network)",
    async send(job: Job, onEvent?: OnEvent): Promise<Reply> {
      const say = onEvent ?? (() => undefined);
      try {
        await wait(300);
        const scope = await verifyJob(job.body, job.jobId, o.trust, o.now?.());
        say("enclave: presentation and consent credential verified");
        await wait(500);
        say("enclave: fetched mock AA data under the consent, analysed, sealed to the device key");
        return { outcome: "ok", output: await processJob(job.body, scope) };
      } catch (e) {
        if (e instanceof EnclaveRefusal) return { outcome: "error", errorType: e.errorType };
        throw e;
      }
    },
  };
}
