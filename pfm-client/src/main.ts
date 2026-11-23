/**
 * PFM client — UI shell. All data reaches the DOM through textContent (record
 * narrations are untrusted strings); there is no innerHTML anywhere.
 */
import { loadOrCreateDeviceKeys, indexedDbKeyStore, publicJwk, thumbprint, type DeviceKeys } from "./lib/keys";
import { didKeyFromP256Jwk } from "./lib/didkey";
import { openKV, type KV } from "./lib/storage";
import { createMockIssuer } from "./mock/issuer";
import { createMockTransport } from "./mock/transport";
import { createKmsCall, createQueueCrypto } from "./transport/envelope";
import { createPubSubClient } from "./transport/pubsubClient";
import { createPubSubTransport } from "./transport/pubsub";
import { resolveNames, type Env } from "./transport/names";
import { PfmRequestError, requestInsights, type Insights, type InsightsResult } from "./pfm/session";
import { parseBundle } from "./vc/credentials";
import { fetchChain, runViaAirlock, RunFailedError, type Evidence } from "./transport/airlockRuns";
import { createRelayTransport, relayConfig, relayCredentials, relayLogin } from "./transport/relay";
import type { Transport } from "./transport/types";

interface Config { mode: "mock" | "relay" | "airlock" | "pubsub"; env: Env; partner: string; relayUrl: string }
// Default: the Cloud Run mock FIU backend (sahamati-labs, asia-south1). Mock mode needs no network.
const DEFAULTS: Config = { mode: "relay", env: "sandbox", partner: "pfm", relayUrl: "https://pfm-fiu-backend-334610188311.asia-south1.run.app" };

type Child = Node | string;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}
const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

async function main() {
  const root = document.getElementById("app")!;
  const kv: KV = await openKV();
  const cfg: Config = { ...DEFAULTS, ...((await kv.get<Config>("config")) ?? {}) };
  const keys: DeviceKeys = await loadOrCreateDeviceKeys(indexedDbKeyStore());
  const holderJwk = await publicJwk(keys.holder.publicKey);
  const holderDid = didKeyFromP256Jwk(holderJwk);
  const replyKid = await thumbprint(await publicJwk(keys.reply.publicKey));
  let token = ""; // memory only — never persisted

  const logEl = el("pre", { class: "log", "aria-live": "polite" });
  const say = (l: string) => { logEl.append(`${new Date().toLocaleTimeString()}  ${l}\n`); logEl.scrollTop = logEl.scrollHeight; };
  const resultEl = el("div");
  const goBtn = el("button", {}, "Get my spending insights");
  const status = el("div", { class: "muted" });

  const mode = el("select", {}, el("option", { value: "mock" }, "Mock enclave (offline)"), el("option", { value: "relay" }, "FIU backend (relay)"), el("option", { value: "airlock" }, "FIU backend (Airlock)"), el("option", { value: "pubsub" }, "Pub/Sub queue (sandbox/preprod)"));
  mode.value = cfg.mode;
  const env = el("select", {}, el("option", { value: "sandbox" }, "sandbox"), el("option", { value: "preprod" }, "preprod"));
  env.value = cfg.env;
  const partner = el("input", { value: cfg.partner, autocapitalize: "none", spellcheck: "false" });
  const tokenIn = el("input", { type: "password", autocomplete: "off", placeholder: "gcloud auth print-access-token" });
  const bundleIn = el("textarea", { placeholder: '{"agent":"<vc+jwt>","consent":"<vc+jwt>"}', spellcheck: "false" });
  const relayIn = el("input", { value: cfg.relayUrl, autocapitalize: "none", spellcheck: "false" });
  const relayBox = el("div", {}, el("label", {}, "Backend URL (local dev: http://localhost:8787, emulator: http://10.0.2.2:8787)", relayIn));
  const queueBox = el("div", {},
    el("div", { class: "banner" }, "Development only. A phone should not be the queue's requester identity in production — see README → Transport. Token stays in memory and is dropped when the app closes."),
    el("label", {}, "Environment", env), el("label", {}, "Partner slot id", partner),
    el("label", {}, "OAuth access token", tokenIn),
    el("label", {}, "Credentials (agent + consent, from your issuer)", bundleIn));
  const accessIn = el("input", { type: "password", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
  const accessBox = el("div", {}, el("label", {}, "Access key (Airlock backend; kept in memory only)", accessIn));
  const syncMode = () => { accessBox.style.display = mode.value === "airlock" ? "" : "none"; syncMode2(); };
  const syncMode2 = () => { queueBox.style.display = mode.value === "pubsub" ? "" : "none"; relayBox.style.display = mode.value === "relay" || mode.value === "airlock" ? "" : "none"; };
  mode.onchange = syncMode; syncMode();

  async function transport(): Promise<{ t: Transport; creds: Parameters<typeof requestInsights>[0]["credentials"]; audience: string }> {
    if (mode.value === "mock") {
      const names = resolveNames("sandbox", "pfm");
      const issuer = await createMockIssuer();
      const t = createMockTransport({ trust: { issuerJwk: issuer.publicJwk, workloadAudience: names.audience, seen: new Set() } });
      return { t, creds: (h) => issuer.issue(h), audience: names.audience };
    }
    if (mode.value === "relay") {
      const url = relayIn.value.trim();
      const conf = await relayConfig(url);
      const tok = await relayLogin(url, "customer-test-001");
      return { t: createRelayTransport({ baseUrl: url, token: tok }), audience: conf.audience, creds: (h) => relayCredentials(url, tok, h) };
    }
    if (!token.trim()) throw new Error("paste an access token first");
    const names = resolveNames(env.value as Env, partner.value.trim());
    const supplier = async () => token.trim();
    const t = createPubSubTransport({ names, pubsub: createPubSubClient(supplier), crypto: createQueueCrypto({ requestKek: names.requestKek, replyKek: names.replyKek, kms: createKmsCall(supplier) }) });
    return {
      t, audience: names.audience,
      creds: async () => {
        const raw = bundleIn.value.trim() ? JSON.parse(bundleIn.value) : await kv.get("bundle");
        const b = parseBundle(raw);
        await kv.set("bundle", b); // synthetic-only in sandbox; guard enforces it
        return b;
      },
    };
  }

  goBtn.onclick = async () => {
    goBtn.disabled = true; resultEl.replaceChildren(); status.textContent = "";
    await kv.set("config", { mode: mode.value as Config["mode"], env: env.value as Env, partner: partner.value.trim(), relayUrl: relayIn.value.trim() } satisfies Config);
    try {
      if (mode.value === "airlock") {
        const url = relayIn.value.trim();
        const tok = await relayLogin(url, "customer-test-001", fetch, accessIn.value.trim() || undefined);
        say("airlock run: the FIU backend runs it; the app holds no Airlock secret");
        const r = await runViaAirlock({ baseUrl: url, token: tok, onStage: (st, runId) => { status.textContent = `Working… (${st.replace(/_/g, " ")})`; say(`stage: ${st}${runId ? ` · run ${runId}` : ""}`); } });
        status.textContent = "";
        resultEl.replaceChildren(renderAnswer(r.answer), renderEvidence(r.evidence, () => fetchChain(url, tok, r.id)));
        return;
      }
      const { t, creds, audience } = await transport();
      say(`transport: ${t.name}`);
      const res = await requestInsights({ keys, transport: t, credentials: creds, audience }, undefined, say);
      await kv.set("lastSealed", { jobId: res.jobId, sealed: res.sealed }); // ciphertext only
      resultEl.replaceChildren(render(res));
      status.textContent = "";
    } catch (e) {
      const m = e instanceof RunFailedError ? `The run did not produce a reply: ${e.message}` : e instanceof PfmRequestError ? `Refused by the enclave: ${e.errorType}` : e instanceof Error ? e.message : String(e);
      status.className = "err"; status.textContent = m; say(`error: ${m}`);
    } finally { goBtn.disabled = false; }
  };

  const forget = el("button", { class: "secondary" }, "Forget this device");
  forget.onclick = async () => {
    if (!confirm("Delete the device keys and stored data? Past sealed replies become unreadable.")) return;
    indexedDB.deleteDatabase("pfm-device"); await kv.delete("bundle"); await kv.delete("lastSealed"); location.reload();
  };

  root.append(
    el("h1", {}, "PFM insights"),
    el("div", { class: "banner" }, "Synthetic data only. Nothing here is a real customer, consent or account."),
    el("div", { class: "card" }, el("h2", {}, "This device"),
      el("div", { class: "kv" }, el("span", {}, "Holder DID"), el("span", {}, holderDid), el("span", {}, "Reply key"), el("span", {}, replyKid))),
    el("div", { class: "card" }, el("h2", {}, "Connection"), el("label", {}, "Transport", mode), relayBox, accessBox, queueBox),
    el("div", { class: "row" }, goBtn, forget), status,
    el("div", { class: "card" }, el("h2", {}, "Activity"), logEl),
    resultEl,
  );
}

const isInsights = (a: unknown): a is Insights =>
  !!a && typeof a === "object" && typeof (a as Insights).totals?.spend === "number" && Array.isArray((a as Insights).outflowsByCategory) && Array.isArray((a as Insights).accounts);

/** The agent's JSON shape is the agent builder's to define: render the PFM shape when it matches, else show it raw. */
function renderAnswer(a: unknown): HTMLElement {
  if (isInsights(a)) return render({ jobId: "", insights: a, meta: {}, sealed: "", provenance: null }, "Opened by the FIU backend (not end-to-end sealed to this device)");
  const box = el("div", { class: "card" }, el("h2", {}, "Agent reply"));
  box.append(el("pre", { class: "log" }, JSON.stringify(a, null, 2)));
  return box;
}

function renderEvidence(ev: Evidence | undefined, chain: () => Promise<string>): HTMLElement {
  const box = el("div", { class: "card" }, el("h2", {}, "Evidence"));
  if (!ev) return box;
  box.append(el("div", { class: "kv" },
    el("span", {}, "Run"), el("span", {}, `${ev.runId} (${ev.environment})`),
    el("span", {}, "Agent"), el("span", {}, `${ev.agentWorkloadId} · ${ev.agentDigest}`),
    el("span", {}, "Consent"), el("span", {}, ev.consentId),
    el("span", {}, "Started"), el("span", {}, ev.startedAt)));
  const tl = el("ol", { class: "muted" });
  for (const r of ev.receipts) tl.append(el("li", {}, r.at ? `${r.type} · ${r.at}` : r.type));
  box.append(tl);
  // No "verified" badge: the api's own verdict is not an independent check.
  box.append(el("p", { class: "muted" }, "Not independently verified here. Download the chain export and run `airlock verify-note` on it (Octic, Sahamati or an auditor)."));
  const dl = el("button", { class: "secondary" }, "Download chain export");
  dl.onclick = async () => {
    const url = URL.createObjectURL(new Blob([await chain()], { type: "application/json" }));
    const a = el("a", { href: url, download: `run-${ev.runId}.chain.json` }); document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  box.append(dl);
  return box;
}

function render(r: InsightsResult, note = "Decrypted on this device"): HTMLElement {
  const d: Insights = r.insights;
  const box = el("div", { class: "card" });
  box.append(el("h2", {}, "Your spending"));
  if (d.period) box.append(el("div", { class: "muted" }, `${d.period.from} → ${d.period.to} · ${d.recordsIn} transactions · ${d.accounts.length} accounts`));
  const t = d.totals;
  for (const [k, v] of [["Spend", inr(t.spend)], ["Income", inr(t.income)], ["Savings rate", t.savingsRatePct != null ? `${t.savingsRatePct}%` : "n/a"], ["Essential share", t.essentialSharePct != null ? `${t.essentialSharePct}%` : "n/a"]] as const)
    box.append(el("div", { class: "stat" }, el("span", {}, k), el("strong", {}, v)));

  if (d.nudges?.selected.length) {
    box.append(el("h2", { style: "margin-top:14px" }, "For you today"));
    for (const n of d.nudges.selected) box.append(el("div", { class: "nudge" }, n.text));
  }
  box.append(el("h2", { style: "margin-top:14px" }, "By category"));
  const max = Math.max(1, ...d.outflowsByCategory.map((c) => c.total));
  for (const c of d.outflowsByCategory.slice(0, 8)) {
    const bar = el("div", { class: "bar" }); bar.style.width = `${Math.round((c.total / max) * 100)}%`;
    box.append(el("div", {}, el("div", { class: "stat" }, el("span", {}, c.category), el("span", {}, inr(c.total))), bar));
  }
  box.append(el("p", { class: "muted", style: "margin-top:14px" },
    `${note} · decider ${d.decider?.backend ?? "?"}@${d.decider?.version ?? "?"} · reply provenance: ${r.provenance ? "present (not yet verified here)" : "none"}`));
  return box;
}

main().catch((e) => { document.body.textContent = `Failed to start: ${e instanceof Error ? e.message : String(e)}`; });
