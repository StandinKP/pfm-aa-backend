/**
 * PFM client — view layer. State lives in src/state (store + controller); this file renders it and
 * dispatches intents. All data reaches the DOM through textContent (record narrations are untrusted
 * strings); there is no innerHTML anywhere.
 */
import { loadOrCreateDeviceKeys, indexedDbKeyStore, publicJwk, thumbprint, type DeviceKeys } from "./lib/keys";
import { didKeyFromP256Jwk } from "./lib/didkey";
import { openKV, type KV } from "./lib/storage";
import type { Env } from "./transport/names";
import type { Insights } from "./pfm/session";
import { fetchChain, runViaAirlock, RunFailedError, type Evidence } from "./transport/airlockRuns";
import { relayLogin } from "./transport/relay";
import { createStore } from "./state/store";
import { initialState, reduce, type Action, type AppState } from "./state/app";
import { DEFAULTS, type Config } from "./state/config";
import { createController } from "./state/controller";

type Child = Node | string;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}
const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/** What the renderer needs; both the derived ledger insights and an Airlock answer satisfy it. */
type View = Pick<Insights, "recordsIn" | "accounts" | "totals" | "outflowsByCategory"> & Partial<Pick<Insights, "period" | "nudges" | "decider" | "months">> & { recurring?: Array<{ narration: string; cadence: string; medianAmount: number; nextExpected: string }> };

async function main() {
  const root = document.getElementById("app")!;
  const kv: KV = await openKV();
  const cfg: Config = { ...DEFAULTS, ...((await kv.get<Config>("config")) ?? {}) };
  const keys: DeviceKeys = await loadOrCreateDeviceKeys(indexedDbKeyStore());
  const holderDid = didKeyFromP256Jwk(await publicJwk(keys.holder.publicKey));
  const replyKid = await thumbprint(await publicJwk(keys.reply.publicKey));

  const store = createStore<AppState, Action>(reduce, initialState(cfg));
  const ctl = createController({ kv, keys, store });
  const s = ctl.secrets;

  // --- inputs (static: never rebuilt, so focus and typing survive re-renders) ---
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

  const readConfig = (): Config => ({ mode: mode.value as Config["mode"], env: env.value as Env, partner: partner.value.trim(), relayUrl: relayIn.value.trim() });
  const onConfig = () => ctl.setConfig(readConfig());
  for (const i of [mode, env, partner, relayIn]) i.addEventListener("change", onConfig);
  tokenIn.addEventListener("input", () => { s.token = tokenIn.value; });
  bundleIn.addEventListener("input", () => { s.bundleText = bundleIn.value; });
  accessIn.addEventListener("input", () => { s.accessKey = accessIn.value; });
  const syncBoxes = () => {
    accessBox.style.display = mode.value === "airlock" ? "" : "none";
    queueBox.style.display = mode.value === "pubsub" ? "" : "none";
    relayBox.style.display = mode.value === "relay" || mode.value === "airlock" ? "" : "none";
  };
  mode.addEventListener("change", syncBoxes);
  syncBoxes();

  // --- actions ---
  const goBtn = el("button", {}, "Get my spending insights");
  const cancelBtn = el("button", { class: "secondary" }, "Cancel");
  const resumeBtn = el("button", {}, "Resume");
  const forget = el("button", { class: "secondary" }, "Forget this device");
  const status = el("div", { class: "muted", role: "status", "aria-live": "polite" });
  const meta = el("div", { class: "muted" });
  const logEl = el("pre", { class: "log", "aria-live": "polite" });
  const resultEl = el("div");
  const airlockEl = el("div"); // Airlock answers are not part of the ledger (the backend opens them)
  let airlockBusy = false;

  async function runAirlock() {
    airlockBusy = true; airlockEl.replaceChildren(); status.className = "muted"; syncView();
    try {
      const url = relayIn.value.trim();
      const tok = await relayLogin(url, "customer-test-001", fetch, accessIn.value.trim() || undefined);
      store.dispatch({ t: "log", line: "airlock run: the FIU backend runs it; the app holds no Airlock secret" });
      const r = await runViaAirlock({ baseUrl: url, token: tok, onStage: (st, runId) => { status.textContent = `Working… (${st.replace(/_/g, " ")})`; store.dispatch({ t: "log", line: `stage: ${st}${runId ? ` · run ${runId}` : ""}` }); } });
      status.textContent = "";
      airlockEl.replaceChildren(renderAnswer(r.answer), renderEvidence(r.evidence, () => fetchChain(url, tok, r.id)));
    } catch (e) {
      const m = e instanceof RunFailedError ? `The run did not produce a reply: ${e.message}` : e instanceof Error ? e.message : String(e);
      status.className = "err"; status.textContent = m;
    } finally { airlockBusy = false; syncView(); }
  }

  goBtn.onclick = () => (mode.value === "airlock" ? void runAirlock() : void ctl.refresh());
  resumeBtn.onclick = () => void ctl.resume();
  cancelBtn.onclick = () => ctl.cancel();
  forget.onclick = async () => {
    if (!confirm("Delete the device keys, the stored ledger and cached credentials? This cannot be undone.")) return;
    await ctl.forget();
    location.reload();
  };

  // --- render from state ---
  function syncView() {
    const st = store.get();
    const working = st.phase === "working" || airlockBusy;
    const airlock = st.config.mode === "airlock";
    goBtn.disabled = working || (!airlock && st.cadence?.manualAllowed === false);
    goBtn.textContent = airlock ? "Get my spending insights" : st.ledgerTxns ? "Refresh" : "Get my spending insights";
    cancelBtn.style.display = st.phase === "working" && !airlock ? "" : "none";
    resumeBtn.style.display = st.phase === "interrupted" && st.pendingJobId ? "" : "none";
    if (!airlockBusy && !(status.className === "err" && airlockEl.childNodes.length === 0 && st.phase === "idle" && !st.status)) {
      status.className = st.phase === "error" ? "err" : "muted";
      status.textContent = st.status;
    }
    const lines: string[] = [];
    if (st.cadence && !airlock && st.ledgerTxns) {
      if (st.cadence.lastFetchAt) lines.push(`Last updated ${new Date(st.cadence.lastFetchAt).toLocaleString()}`);
      lines.push(st.cadence.due ? "A refresh is due." : st.cadence.nextDueAt ? `Next refresh due ${new Date(st.cadence.nextDueAt).toLocaleDateString()}.` : "");
      lines.push(`${st.cadence.fetchesLeft} fetches left this month.`);
      if (st.cadence.reason && st.cadence.manualAllowed === false) lines.push(st.cadence.reason);
    }
    if (st.lastRun) lines.push(`Last refresh: ${st.lastRun.newTxns} new transactions · ${st.lastRun.modelCalls} model decisions · ${st.lastRun.keysCached} reused from this device.`);
    meta.textContent = lines.filter(Boolean).join(" ");
    logEl.textContent = st.log.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }
  let lastInsights: AppState["insights"] | undefined;
  let lastLegacy: AppState["legacy"] | undefined;
  store.subscribe((st) => {
    syncView();
    if (st.insights !== lastInsights || st.legacy !== lastLegacy) {
      lastInsights = st.insights;
      lastLegacy = st.legacy;
      resultEl.replaceChildren(
        ...(st.insights
          ? [render(st.insights as unknown as View, `Derived on this device from ${st.ledgerTxns} stored transactions`)]
          : st.legacy && isInsights(st.legacy)
            ? [render(st.legacy, "Full result from an enclave without incremental mode (not stored)")]
            : []),
      );
    }
  });

  root.append(
    el("h1", {}, "PFM insights"),
    el("div", { class: "banner" }, "Synthetic data only. Nothing here is a real customer, consent or account."),
    el("div", { class: "card" }, el("h2", {}, "This device"),
      el("div", { class: "kv" }, el("span", {}, "Holder DID"), el("span", {}, holderDid), el("span", {}, "Reply key"), el("span", {}, replyKid))),
    el("div", { class: "card" }, el("h2", {}, "Connection"), el("label", {}, "Transport", mode), relayBox, accessBox, queueBox),
    el("div", { class: "row" }, goBtn, cancelBtn, resumeBtn, forget), status, meta,
    el("div", { class: "card" }, el("h2", {}, "Activity"), logEl),
    resultEl, airlockEl,
  );
  await ctl.boot();
  syncView();
}

const isInsights = (a: unknown): a is Insights =>
  !!a && typeof a === "object" && typeof (a as Insights).totals?.spend === "number" && Array.isArray((a as Insights).outflowsByCategory) && Array.isArray((a as Insights).accounts);

/** The agent's JSON shape is the agent builder's to define: render the PFM shape when it matches, else show it raw. */
function renderAnswer(a: unknown): HTMLElement {
  if (isInsights(a)) return render(a, "Opened by the FIU backend (not end-to-end sealed to this device)");
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

function render(d: View, note = "Decrypted on this device"): HTMLElement {
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
  if (d.months?.length) {
    box.append(el("h2", { style: "margin-top:14px" }, "Month by month"));
    for (const m of d.months.slice(-6)) {
      const delta = m.spendDeltaPct != null ? ` (${m.spendDeltaPct > 0 ? "+" : ""}${m.spendDeltaPct}%)` : "";
      box.append(el("div", { class: "stat" }, el("span", {}, m.month), el("span", {}, `${inr(m.spend)}${delta}`)));
    }
  }
  if (d.recurring?.length) {
    box.append(el("h2", { style: "margin-top:14px" }, "Recurring"));
    for (const r of d.recurring.slice(0, 5)) box.append(el("div", { class: "stat" }, el("span", {}, `${r.narration} · ${r.cadence}`), el("span", {}, inr(r.medianAmount))));
  }
  box.append(el("p", { class: "muted", style: "margin-top:14px" }, `${note} · labels by ${d.decider?.backend ?? "the enclave"}${d.decider ? `@${d.decider.version}` : ""}`));
  return box;
}

main().catch((e) => { document.body.textContent = `Failed to start: ${e instanceof Error ? e.message : String(e)}`; });
