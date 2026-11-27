/**
 * Everything about this agent the shared runner cannot know: the Pix charge rail and its sandbox payer, the order policy
 * the core runs as its `policyExtension`, the tool handlers, the words the customer and the store read, and what a
 * one-shot prints as JSON. The runner (`@codespar/agent-runtime`) owns the rest.
 *
 * The rails are the collections and checkout agents' own, not new ones: `StubChargeRail` (simulated issuer and payer),
 * `CodeSparChargeRail` for `--rail api`, and, hosted on the integrated Test, the platform's receive proposals (CONTRATO
 * v1.6) that the runtime wires from `hosted.platformServes`. There is no consent step: the collection policy is the
 * store's own (the receiving side has no API-signed policy today), so the example file is the policy in both rails.
 */
import { relative } from "node:path";
import qrcode from "qrcode-terminal";
import {
  CodeSparChargeRail,
  StubChargeRail,
  createCodeSparClient,
  assertTestKey,
  loadMandate,
  payIfPayable,
  formatBRL,
  formatDay,
  CORE_STRINGS,
  type Execution,
  type StubChargeRailOptions,
  railErrorOf,
} from "@codespar/agent-core";
import { defineAgent, type AgentKit } from "@codespar/agent-runtime";
import { makeHandlers } from "./modules/pix-charge.js";
import { orderPolicy } from "./orders.js";
import { STRINGS } from "./strings.js";

const kit: AgentKit = {
  settlement: "await-payer",
  scenarioRail: "requested",
  // bolepix-receivables is lifted ONLY for the codespar-test executor, which goes through the platform's charge port (a
  // receive proposal the platform issues as a Collect charge at the provider's sandbox and its Test payer pays). The kit's
  // standalone `--rail api` stays blocked in agent.yaml while ent#1816 is open, like collections and checkout (v1.6).
  hosted: { platformServes: ["bolepix-receivables"] },

  labels: {
    defaultUser: "usr_store",
    evalUser: "usr_store",
    missingReceiptKind: "record_missing_locally",
    missingReceiptDetail: (receiptId, runId) => `paid charge ${receiptId} is not in runs/${runId}/receipts`,
    stillExecuting: (e) => `${e.id}: still executing (${e.reason}) — ${e.detail}; nothing was re-issued; \`npm run poll\` keeps looking`,
  },
  strings: STRINGS,

  usage: () => `pix-payment-agent
  npm start                                                  interactive terminal (you are the customer)
  npm start -- --input "oi, quero pagar o pedido 2001 no Pix"  one turn (add --approve/--deny to decide, --json for machine output)
  npm start -- --scenario <name>                             run a scenario pack (see scenarios/)
  npm run poll                                               back to a charge whose payment landed after the run ended
options: --mode human|mandate  --provider anthropic|gemini|replay  --transcript <file>  --rail stub|api  --user <id>
         --wait <seconds>  --simulate-payer  --payer pays|expires|never (stub only)  --json
         --now <ISO 8601>  pin the run to that instant (due dates, timestamps); env CODESPAR_AGENT_NOW is the same thing
         --locale pt-BR|en  the language of what the code prints (the model answers in the language the person types either way)`,

  buildRail: (ctx) => {
    const mandate = ctx.mandate ?? loadMandate(ctx.manifest.resolvePath(ctx.manifest.manifest.mandate_schema));
    if (ctx.kind === "api") {
      assertTestKey(ctx.env["CODESPAR_API_KEY"]);
      const client = createCodeSparClient({ apiKey: ctx.env["CODESPAR_API_KEY"], baseUrl: ctx.env["CODESPAR_API_URL"], projectId: ctx.env["CODESPAR_PROJECT_ID"] });
      return {
        rail: new CodeSparChargeRail(client),
        mandate,
        api: client,
        pollIntervalMs: 3000,
        payer: {
          kind: "api" as const,
          async pay(chargeId: string) {
            const result = await payIfPayable(client, chargeId);
            if (!result.ok) return { ok: false as const, detail: "refused" in result ? `${result.refused.code}: ${result.refused.message}` : `${result.failure.code}: ${result.failure.message}` };
            const s = result.state;
            return { ok: true as const, detail: `sandbox payer: ${s.charge_id} ${s.status} (${s.payment}, ${s.paid_minor} of ${s.quoted_minor}), simulated=${s.simulated}, settled_against=${s.settled_against}, money_moved=${s.money_moved}${s.idempotent_replay ? ", replay" : ""}` };
          },
          behave() {
            /* the API's payer is a route, not a fixture; a scenario that needs "expires" declares rails: [stub] */
          },
        },
      };
    }
    // PIX_PAYMENT_KILL_AFTER_DISPATCH=1 simulates a crash right after the issuer accepted the charge and before the outcome was recorded.
    const killAfterDispatch = ctx.envVar("KILL_AFTER_DISPATCH") === "1" ? { afterDispatch: () => process.exit(137) } : {};
    // PIX_PAYMENT_STUB_PAYER=pays|expires|never: what the fixture payer does, from a test process.
    const behaviour = ctx.envVar("STUB_PAYER");
    const fixture: Pick<StubChargeRailOptions, "payer"> = behaviour === "pays" || behaviour === "expires" || behaviour === "never" ? { payer: behaviour } : {};
    const refuse = ctx.envVar("STUB_REFUSE") ? { refusePayees: ctx.envVar("STUB_REFUSE")!.split(",").map((p) => p.trim()).filter(Boolean) } : {};
    const stub = new StubChargeRail(ctx.store, { ...(ctx.now ? { clock: ctx.now } : {}), ...killAfterDispatch, ...fixture, ...refuse, ...(ctx.stubRail ?? {}) });
    return {
      rail: stub,
      mandate,
      pollIntervalMs: 0,
      payer: {
        kind: "stub" as const,
        async pay(_chargeId: string, attemptId: string) {
          stub.decide(attemptId, "pays");
          return { ok: true as const, detail: "stub payer: will pay at the next look" };
        },
        behave: (b) => stub.setPayer(b),
        decideFor: (attemptId, b) => stub.decide(attemptId, b),
      },
    };
  },

  handlers: (setup) => makeHandlers(() => setup.locale, setup.rail),
  policyExtension: ({ locale }) => orderPolicy(locale),

  describeExecution: (execution, setup) => {
    const text = setup.coreStrings;
    const words = STRINGS[setup.locale];
    const lines: string[] = [];
    const item = execution.items[0];
    lines.push(`  ${text.execution} ${execution.id}: ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`);
    lines.push(`    ${words.orderOf(item?.beneficiary ?? "?", item?.alias ?? "?")}`);
    if (item) lines.push(`    - ${words.amountLine(formatBRL(item.amount, setup.locale), item.due_date ? formatDay(item.due_date, setup.locale) : "?")}`);
    lines.push(`    ${text.totalByCore}: ${formatBRL(execution.total, setup.locale)}`);
    if (execution.escalation) lines.push(`    ${text.escalatedBy}: ${execution.escalation.trigger} — ${execution.escalation.detail}`);
    if (execution.blocking_reasons.length) lines.push(`    ${text.blocked(execution.blocking_reasons.join(", "), words.notAuthorized)}`);
    if (execution.detail && execution.state !== "awaiting_approval") lines.push(`    ${execution.detail}`);
    for (const outcome of execution.outcomes) {
      if (outcome.transaction_id) lines.push(`    ${words.chargeWord}: ${outcome.transaction_id} — ${outcome.status}${outcome.code ? ` (${outcome.code})` : ""}`);
      if (outcome.receipt_id) lines.push(`    ${words.receiptWord}: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
    }
    return lines;
  },

  oneShotPayload: ({ setup: s, reply, toolCalls, executions, startedAt }) => ({
    run_id: s.runId,
    agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`,
    mode: s.mode,
    rail: s.railKind,
    policy_id: s.mandate.id,
    actor: s.engine.agentActor,
    reply,
    tool_calls: toolCalls,
    executions: executions.map((e) => ({
      id: e.id,
      state: e.state,
      reason: e.reason ?? null,
      rail_error: railErrorOf(e),
      escalation: e.escalation ?? null,
      order: e.items[0]?.alias ?? null,
      total_minor: e.total,
      approval_id: e.approval_id ?? null,
      charge_id: e.outcomes[0]?.transaction_id ?? null,
      charge_status: e.outcomes[0]?.status ?? null,
      payable: e.outcomes[0]?.instrument?.payable ?? null,
      pix_copy_paste: e.outcomes[0]?.instrument?.pix_copy_paste ?? null,
      receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
    })),
    receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
    bundle_dir: relative(process.cwd(), s.bundle.dir),
    seconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
  }),

  /** What the customer reads when the charge is payable: the QR as an image and the copia-e-cola under it. */
  presentInstrument: (execution, _instalment, chargeId, instrument, tell, locale) => {
    const text = CORE_STRINGS[locale];
    const item = execution.items[0];
    tell("");
    tell(`${item ? formatBRL(item.amount, locale) : ""}${instrument.due_date ? text.dueOn(formatDay(instrument.due_date, locale)) : ""}${text.chargeRef(chargeId)}`);
    if (instrument.pix_copy_paste) {
      qrcode.generate(instrument.pix_copy_paste, { small: true }, (qr: string) => {
        for (const line of qr.split("\n")) tell(line);
      });
      tell(text.pixCopyPaste);
      tell(instrument.pix_copy_paste);
    }
    tell("");
  },

  announceOutcome: (execution, setup, tell) => {
    if (execution.state === "executing") return false;
    if (!setup.engine.markTold(execution.id, execution.state)) return false;
    const words = STRINGS[setup.locale];
    let text: string;
    if (execution.state === "settled") text = words.toldSettled(execution.outcomes.map((o) => o.transaction_id).filter(Boolean).join(", "));
    else if (execution.reason === "charge_expired") text = words.toldExpired;
    else if (execution.reason === "charge_cancelled") text = words.toldCancelled;
    // Issued, then its reference turned ambiguous: a charge exists and nobody can yet say whether it was paid. Never "nada foi cobrado".
    else if (execution.reason === "charge_reference_ambiguous") text = words.toldAmbiguous;
    else if (execution.state === "failed") text = words.toldFailed(execution.reason);
    else if (execution.state === "denied") text = words.toldDenied(execution.reason);
    else text = words.toldUndecided(execution.state);
    tell(text);
    setup.engine.note("message.debtor", execution.id, { state: execution.state, reason: execution.reason ?? null, text });
    return true;
  },

  /** Webhook duplicated or out of order: the same `commerce.charge.paid` twice, `paid` before `created`, `expired` after `paid`. One settled, one message. */
  runEventsCase: async (s, tell) => {
    s.payer!.behave("never");
    const draft = await s.engine.draft({ items: [{ payee: "pedido-2001", amount: 1800, due_date: s.engine.today() }] });
    if (!draft.ok) throw new Error(`refused: ${draft.reason}`);
    let execution = draft.execution;
    if (execution.state === "awaiting_approval") execution = s.engine.approve(execution.id, { id: "usr_store", channel: "terminal" });
    execution = await s.engine.execute(execution.id);
    const chargeId = execution.outcomes[0]!.transaction_id!;
    const apply = (event_id: string, type: string) => {
      s.engine.ingestExternalEvent({ event_id, type, transaction_id: chargeId });
      kit.announceOutcome!(s.engine.get(execution.id)!, s, tell);
    };
    apply("evt_paid_1", "commerce.charge.paid");
    apply("evt_paid_1", "commerce.charge.paid");
    apply("evt_created_late", "commerce.charge.created");
    apply("evt_paid_2", "commerce.charge.paid");
    apply("evt_expired_late", "commerce.charge.expired");
  },

  // The payer's behaviour is part of the recording: a charge that expired in the original run expires in the rerun.
  rerunPlan: (events) => {
    const expired = events.some((e) => e["type"] === "execution.transition" && (e["payload"] as { reason?: string }).reason === "charge_expired");
    return { stubRail: { payer: expired ? "expires" : "pays" }, simulatePayer: !expired };
  },
  rerunComparesOutcomes: false,

  evalScenarioLine: (check) =>
    `${check.ok ? "ok  " : "FAIL"} scenario/${check.run.scenario} [${check.mode}] — states ${JSON.stringify(check.run.executions.map((e) => e.state))}, ${check.run.charges_issued} charge(s), ${check.run.receipts} record(s), ${check.run.debtor_messages} message(s)${check.failures.length ? ` — ${check.failures.join("; ")}` : ""}`,
};

export const agent = defineAgent(import.meta.url, kit);
