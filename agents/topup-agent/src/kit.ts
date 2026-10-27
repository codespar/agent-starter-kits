/**
 * Everything about this agent the shared runner cannot know: the pull rail
 * (Iniciador's sweeping sandbox with `--rail api`, an offline fixture
 * otherwise), the mandate the two limits come into, the tool handlers, the
 * words the person and the operator read, and what a one-shot prints as JSON.
 *
 * To the core a pull is a receivable (`settlement: await-payer`): the rail
 * answers `accepted` with the bank's consent link, the runner shows it and
 * looks until the person approved at the bank and the money landed, or the
 * link expired. There is no sandbox payer route: in the sandbox the person
 * approves on the simulated bank's page (Mocktora), by hand.
 */
import { relative } from "node:path";
import { CORE_STRINGS, formatBRL, loadMandate, railErrorOf, type Execution, type Mandate } from "@codespar/agent-core";
import { defineAgent, toldKey, type AgentKit, type SandboxPayer } from "@codespar/agent-runtime";
import { HttpSweepingApi } from "./iniciador.js";
import { FixtureSweepingApi, SweepingPullRail, manualRiskSignals, sweepingLimits, type FixtureFate, type SweepingLimits } from "./modules/sweeping-pull.js";
import { STRINGS } from "./strings.js";
import { endToEndOf, makeHandlers } from "./topup.js";

/** The variables `--rail api` needs, by name only. The values live in the agent's `.env` or the shell, never in a tracked file. */
const API_ENV = ["INICIADOR_CLIENT_ID", "INICIADOR_CLIENT_SECRET", "INICIADOR_TEST_TAX_ID", "INICIADOR_CREDITOR_ID", "INICIADOR_TRIGGER_ID", "INICIADOR_PARTICIPANT_ID"] as const;

/**
 * The mandate with the two limits the bank authorization also carries, and,
 * on the sandbox, the configured creditor as its one account. The alias the
 * model names stays `minha-conta`; what it resolves to is the person's.
 */
function mandateFor(base: Mandate, limits: SweepingLimits, creditorId?: string): Mandate {
  const account = base.beneficiaries[0];
  if (!account || base.beneficiaries.length !== 1) throw new Error("topup-agent: the mandate must name exactly one account, the person's own");
  return {
    ...base,
    cap_minor: limits.total_minor,
    per_tx_cap_minor: limits.per_tx_minor,
    ...(creditorId ? { merchant_allowlist: [creditorId], beneficiaries: [{ ...account, payee: creditorId }] } : {}),
  };
}

const kit: AgentKit = {
  settlement: "await-payer",
  scenarioRail: "stub",
  // The live rail is Iniciador's sandbox; buildRail requires its credentials and never calls the CodeSpar API.
  apiRailKey: "none",
  // The same six buildRail requires: with all of them in the shell, a poll after `start --rail api` reads the bank, not the fixture.
  apiRailEnv: API_ENV,

  labels: {
    defaultUser: "usr_operator",
    evalUser: "usr_operator",
    missingReceiptKind: "record_missing_locally",
    missingReceiptDetail: (receiptId, runId) => `completed pull ${receiptId} is not in runs/${runId}/receipts`,
    stillExecuting: (e) => `${e.id}: still executing (${e.reason}) — ${e.detail}; nothing was pulled again; \`npm run poll\` keeps looking`,
  },
  strings: STRINGS,

  usage: () => `topup-agent
  npm start                                                    interactive terminal (you are the person topping up)
  npm start -- --input "quero colocar R$ 1 na minha conta"      one turn (--json for machine output)
  npm start -- --scenario <name>                               run a scenario pack (see scenarios/)
  npm start -- --channel whatsapp --conversation recarga       the conversation channel (needs npm run whatsapp:emulator at the repo root)
  npm start -- --channel whatsapp --conversation recarga --rail api --wait 300
                                                               the same against Iniciador's sweeping sandbox (INICIADOR_* in the environment)
  npm run poll -- --channel whatsapp --conversation recarga    back to a conversation whose pull completed after the run ended
options: --mode mandate|human  --provider anthropic|gemini|replay  --transcript <file>  --rail stub|api  --user <id>
         --wait <seconds>  how long a run looks at the bank before leaving the pull to \`npm run poll\` (api default 60)
         --payer pays|expires|never (stub only: what the person does at the simulated bank)  --json
         --now <ISO 8601>  --locale pt-BR|en
whatsapp: --backend simulator|cloud-api  --conversation <name>  --scripted`,

  buildRail: (ctx) => {
    const limits = sweepingLimits(ctx.env);
    const base = ctx.mandate ?? loadMandate(ctx.manifest.resolvePath(ctx.manifest.manifest.mandate_schema));
    if (ctx.kind === "api") {
      const missing = API_ENV.filter((name) => !ctx.env[name]?.trim());
      if (missing.length > 0) throw new Error(`--rail api needs ${missing.join(", ")} (see the README; the values never go in a tracked file)`);
      const env = (name: (typeof API_ENV)[number]) => ctx.env[name]!.trim();
      const creditorId = env("INICIADOR_CREDITOR_ID");
      const api = new HttpSweepingApi({ baseUrl: ctx.env["INICIADOR_BASE_URL"], credentials: { clientId: env("INICIADOR_CLIENT_ID"), clientSecret: env("INICIADOR_CLIENT_SECRET") } });
      const rail = new SweepingPullRail(
        ctx.store,
        api,
        {
          creditorId,
          triggerId: env("INICIADOR_TRIGGER_ID"),
          participantId: env("INICIADOR_PARTICIPANT_ID"),
          taxId: env("INICIADOR_TEST_TAX_ID"),
          limits,
          riskSignals: manualRiskSignals(ctx.stateDir),
          redirectURL: ctx.env["INICIADOR_REDIRECT_URL"],
          ...(ctx.now ? { clock: ctx.now } : {}),
        },
        true,
      );
      const payer: SandboxPayer = {
        kind: "api",
        async pay() {
          return { ok: false, detail: "the person approves at the bank's page; the sweeping sandbox has no payer route" };
        },
        behave() {
          /* a person, not a fixture */
        },
      };
      return { rail, mandate: mandateFor(base, limits, creditorId), pollIntervalMs: 2000, payer };
    }
    // TOPUP_STUB_PAYER=pays|expires|never: what the fixture person does at the bank, from a test process.
    const fates: Record<string, FixtureFate> = { pays: "approves", expires: "expires", never: "never" };
    // A rerun or a scenario pins the person's behaviour as `{ payer }`, the same option the stub charge rail reads.
    const pinned = ctx.stubRail && "payer" in ctx.stubRail ? ctx.stubRail.payer : undefined;
    const fixture = new FixtureSweepingApi(ctx.store, fates[pinned ?? ctx.envVar("STUB_PAYER") ?? "pays"] ?? "approves");
    const mandate = mandateFor(base, limits);
    const rail = new SweepingPullRail(
      ctx.store,
      fixture,
      { creditorId: mandate.beneficiaries[0]!.payee, triggerId: "trigger-fixture", participantId: "participant-fixture", taxId: "00000000000", limits, riskSignals: manualRiskSignals(ctx.stateDir), ...(ctx.now ? { clock: ctx.now } : {}) },
      true,
    );
    return {
      rail,
      mandate,
      pollIntervalMs: 0,
      payer: {
        kind: "stub",
        async pay(authorizationId: string) {
          fixture.decide(authorizationId, "approves");
          return { ok: true, detail: "fixture: the person approves at the bank" };
        },
        behave: (b) => fixture.setFate(fates[b] ?? "approves"),
        decideFor: (_attemptId, b) => fixture.setFate(fates[b] ?? "approves"),
      },
    };
  },

  handlers: (setup) => makeHandlers(() => setup.locale),

  describeExecution: (execution, setup) => {
    const text = setup.coreStrings;
    const words = STRINGS[setup.locale];
    const lines: string[] = [];
    const item = execution.items[0];
    lines.push(`  ${text.execution} ${execution.id}: ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`);
    lines.push(`    ${words.pullOf(item?.beneficiary ?? "?", item?.alias ?? "?")}`);
    lines.push(`    ${words.pullLine(formatBRL(execution.total, setup.locale))}`);
    if (execution.escalation) lines.push(`    ${text.escalatedBy}: ${execution.escalation.trigger} — ${execution.escalation.detail}`);
    if (execution.blocking_reasons.length) lines.push(`    ${text.blocked(execution.blocking_reasons.join(", "), words.notAuthorized)}`);
    if (execution.detail && execution.state !== "awaiting_approval") lines.push(`    ${execution.detail}`);
    for (const outcome of execution.outcomes) {
      if (outcome.status === "settled") lines.push(`    ${words.endToEndLine}: ${outcome.transaction_id}`);
      else if (outcome.transaction_id) lines.push(`    ${words.authorizationLine}: ${outcome.transaction_id} — ${outcome.status}${outcome.code ? ` (${outcome.code})` : ""}`);
      if (outcome.receipt_id) lines.push(`    ${words.receiptWord}: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
    }
    return lines;
  },

  oneShotPayload: ({ setup: s, reply, toolCalls, executions, startedAt }) => ({
    run_id: s.runId,
    agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`,
    mode: s.mode,
    rail: s.railKind,
    mandate_id: s.mandate.id,
    actor: s.engine.agentActor,
    reply,
    tool_calls: toolCalls,
    executions: executions.map((e) => ({
      id: e.id,
      state: e.state,
      reason: e.reason ?? null,
      rail_error: railErrorOf(e),
      escalation: e.escalation ?? null,
      total_minor: e.total,
      authorization_id: e.outcomes[0]?.status === "settled" ? null : (e.outcomes[0]?.transaction_id ?? null),
      end_to_end_id: endToEndOf(e),
      receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
    })),
    receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
    bundle_dir: relative(process.cwd(), s.bundle.dir),
    seconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
  }),

  /** The terminal's copy of what the WhatsApp channel sends: the amount, then the bank's link on a line of its own. */
  presentInstrument: (execution, _instalment, _authorizationId, instrument, tell, locale) => {
    if (!instrument.consent_url) return;
    tell("");
    tell(formatBRL(execution.total, locale));
    tell(CORE_STRINGS[locale].consentLink);
    tell(instrument.consent_url);
    tell("");
  },

  announceOutcome: (execution, setup, tell) => {
    const words = STRINGS[setup.locale];
    // Stopped at a human: still open, told once, and the console line names the rail's code.
    if (execution.state === "executing" && execution.reason === "rail_needs_human") {
      if (!setup.engine.markTold(execution.id, toldKey(execution))) return false;
      tell(words.toldNeedsHuman);
      setup.engine.note("message.debtor", execution.id, { state: execution.state, reason: execution.reason, text: words.toldNeedsHuman });
      return true;
    }
    if (execution.state === "executing") return false;
    if (!setup.engine.markTold(execution.id, toldKey(execution))) return false;
    let text: string;
    if (execution.state === "settled") text = words.toldSettled(endToEndOf(execution) ?? "?");
    else if (execution.reason === "charge_expired") text = words.toldExpired;
    else if (execution.reason === "charge_cancelled") text = words.toldCancelled;
    else if (execution.state === "failed") text = words.toldFailed(execution.reason);
    else if (execution.state === "denied") text = words.toldDenied(execution.reason);
    else text = words.toldUndecided(execution.state);
    tell(text);
    setup.engine.note("message.debtor", execution.id, { state: execution.state, reason: execution.reason ?? null, text });
    return true;
  },

  /**
   * The outcome as an approved template, for a poll that comes back after the
   * 24-hour window shut. Two outcomes have copy; a declined or failed pull is
   * told inside the turn that produced it, and the poll reports it otherwise.
   */
  outcomeTemplate: (execution, locale) => {
    const amount = formatBRL(execution.total, locale);
    if (execution.state === "settled") return { template: "recarga_concluida", variables: [amount, endToEndOf(execution) ?? "?"] };
    if (execution.reason === "charge_expired") return { template: "recarga_link_expirado", variables: [amount] };
    return undefined;
  },

  /** A prior completed pull, so the velocity window has history. */
  warmUp: async (s, aliases, approver) => {
    const warm = new Set<string>();
    for (const alias of aliases) {
      const d = await s.engine.draft({ items: [{ payee: alias, amount: 100, description: "prior pull" }] });
      if (!d.ok) throw new Error(`warm-up refused: ${d.reason}`);
      let e: Execution = d.execution;
      if (e.state === "awaiting_approval") e = s.engine.approve(e.id, approver);
      if (e.state === "approved") e = await s.engine.execute(e.id);
      for (let i = 0; i < 2 && e.state === "executing"; i += 1) e = await s.engine.reconcile(e.id);
      if (e.state !== "settled") throw new Error(`warm-up for ${alias} ended ${e.state} (${e.reason})`);
      warm.add(e.id);
    }
    return warm;
  },

  /** The same `commerce.charge.paid` twice, `paid` before `created`, `expired` after `paid`: one settled, one message. */
  runEventsCase: async (s, tell) => {
    s.payer!.behave("never");
    const draft = await s.engine.draft({ items: [{ payee: "minha-conta", amount: 100 }] });
    if (!draft.ok) throw new Error("refused");
    let execution = draft.execution;
    if (execution.state === "awaiting_approval") execution = s.engine.approve(execution.id, { id: "usr_operator", channel: "terminal" });
    execution = await s.engine.execute(execution.id);
    const authorizationId = execution.outcomes[0]!.transaction_id!;
    const apply = (event_id: string, type: string) => {
      s.engine.ingestExternalEvent({ event_id, type, transaction_id: authorizationId });
      kit.announceOutcome!(s.engine.get(execution.id)!, s, tell);
    };
    apply("evt_paid_1", "commerce.charge.paid");
    apply("evt_paid_1", "commerce.charge.paid");
    apply("evt_created_late", "commerce.charge.created");
    apply("evt_paid_2", "commerce.charge.paid");
    apply("evt_expired_late", "commerce.charge.expired");
  },

  rerunPlan: (events) => {
    const expired = events.some((e) => e["type"] === "execution.transition" && (e["payload"] as { reason?: string }).reason === "charge_expired");
    return { stubRail: { payer: expired ? "expires" : "pays" }, simulatePayer: !expired };
  },
  rerunComparesOutcomes: false,

  evalScenarioLine: (check) =>
    `${check.ok ? "ok  " : "FAIL"} scenario/${check.run.scenario} [${check.mode}] — states ${JSON.stringify(check.run.executions.map((e) => e.state))}, ${check.run.charges_issued} authorization(s), ${check.run.receipts} record(s), ${check.run.debtor_messages} message(s)${check.failures.length ? ` — ${check.failures.join("; ")}` : ""}`,
};

export const agent = defineAgent(import.meta.url, kit);
