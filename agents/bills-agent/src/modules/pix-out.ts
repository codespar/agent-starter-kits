/**
 * Module `pix-out`: the tool handlers the model can reach. `codespar_pay`
 * hands the proposal to the engine and gets an execution in `drafted` (then
 * whatever the core decided); it cannot pay. `codespar_ledger` and
 * `list_bills` are reads.
 */
import { daysUntil, isReplayedSettlement, type Execution, type ToolHandler } from "@codespar/agent-core";
import { awaitingProposalDecision, forwardedToProposal, type KitConfig } from "@codespar/agent-runtime";
import { formatBRL } from "../bills.js";
import { billsFor, MONTH } from "../bills.js";
import { INTEGRATED_BILLS, integratedProofFrom } from "./integrated-proof.js";

interface PayInput {
  action?: unknown;
  items?: unknown;
  total_minor?: unknown;
}

/**
 * `config` is the run's configuration (`setup.config`): the integrated proof's bills replace the month's when it names one.
 * Otherwise the bills follow the mandate the run is under (`billsFor`).
 */
export const listBills = (config: KitConfig): ToolHandler => async (_input, ctx) => {
  const settled = ctx.engine.list({ state: "settled" });
  const paidAliases = new Set(settled.flatMap((e) => e.items.map((i) => i.alias)).filter(Boolean));
  const today = ctx.engine.today();
  return {
    month: MONTH,
    today,
    bills: (integratedProofFrom(config) ? INTEGRATED_BILLS : billsFor(ctx.engine.mandate, today)).map((b) => ({ ...b, amount: formatBRL(b.amount_minor), days_until_due: daysUntil(today, b.due), paid_this_window: paidAliases.has(b.alias) })),
    payees: ctx.engine.mandate.beneficiaries.map((b) => ({ alias: b.alias, name: b.name })),
  };
};

/**
 * The same request, already held by the provider for a person's approval.
 * The hold itself is the test, not the execution's reason: an unknown
 * sibling attempt renames the reason and the hold is still there.
 */
export const holdsSameRequest = (held: Execution, execution: Execution): boolean =>
  held.id !== execution.id && held.state === "executing" && (held.rail_approvals?.length ?? 0) > 0 && held.mandate.id === execution.mandate.id && held.items_hash === execution.items_hash;

/** The refusal's detail: the execution that holds the request, and the provider approvals it waits on. */
export const heldDetail = (held: Execution): string =>
  `execution ${held.id} is already awaiting provider approval: ${held.rail_approvals?.map((approval) => approval.approval_id).join(", ") ?? "none"}; \`npm run resume\` reads the decision`;

export const codesparPay: ToolHandler = async (raw, ctx) => {
  const input = raw as PayInput;
  if (input.action !== "pix") throw new Error(`codespar_pay: unsupported action ${String(input.action)}; this agent only does pix`);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("codespar_pay: items must be a non-empty array");
  const items = input.items.map((item, i) => {
    const it = item as { payee?: unknown; amount_minor?: unknown; description?: unknown };
    if (typeof it.payee !== "string" || !it.payee.trim()) throw new Error(`codespar_pay: items[${i}].payee must be a payee alias`);
    if (typeof it.amount_minor !== "number" || !Number.isInteger(it.amount_minor) || it.amount_minor <= 0) throw new Error(`codespar_pay: items[${i}].amount_minor must be a positive integer`);
    return { payee: it.payee, amount: it.amount_minor, ...(typeof it.description === "string" ? { description: it.description } : {}) };
  });
  const claimed = typeof input.total_minor === "number" ? { claimed_total: input.total_minor } : {};

  const draft = await ctx.engine.draft({ items, ...claimed });
  if (!draft.ok) {
    // Refused before a draft: no execution will ever say so, and the run's count is taken from this.
    ctx.onNotRun?.({ ref: items.map((item) => item.payee).join(", "), why: "refused", detail: draft.reason });
    return { status: "refused", reason: draft.reason, message: draft.message, paid: false };
  }
  // Any refusal of a request that is already held is reported as the hold: a window cap the hold
  // itself fills is checked before the kit's envelope, and would otherwise hide the original.
  const held = draft.execution.state === "denied" ? ctx.engine.list({ state: "executing" }).find((e) => holdsSameRequest(e, draft.execution)) : undefined;
  const execution = await ctx.onExecution(draft.execution);
  if (held) {
    // The duplicate is not counted as an execution of this run (`runOutcome`), so the line is; a cap's refusal counts as itself.
    if (execution.reason === "duplicate_awaiting_approval") ctx.onNotRun?.({ ref: items.map((item) => item.payee).join(", "), why: "in_progress", detail: heldDetail(held) });
    return { status: "in_progress", execution_id: held.id, approval_ids: held.rail_approvals?.map((approval) => approval.approval_id) ?? [], paid: false };
  }
  return {
    status: execution.state,
    execution_id: execution.id,
    total_minor: execution.total,
    total: formatBRL(execution.total),
    items: execution.items.map((i) => ({ payee: i.beneficiary, amount: formatBRL(i.amount) })),
    ...(execution.reason ? { reason: execution.reason, detail: execution.detail } : {}),
    ...(execution.escalation ? { escalated_by: execution.escalation.trigger } : {}),
    approved_by: approvedBy(execution),
    // A platform proposal waiting for the person (codespar-test): nothing is approved or paid yet, whatever the state reads like.
    ...(awaitingProposalDecision(execution) ? { awaiting: "person_decision_on_proposal" } : {}),
    receipt_ids: execution.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
    // Settled by an earlier presentation of the same attempt: the payment exists, and this call did not make it.
    replayed: isReplayedSettlement(execution),
    paid: execution.state === "settled" && !isReplayedSettlement(execution),
  };
};

export const codesparLedger: ToolHandler = async (raw, ctx) => {
  const input = raw as { action?: unknown; receipt_id?: unknown };
  if (input.action === "executions") {
    return {
      executions: ctx.engine.list().map((e) => ({ id: e.id, state: e.state, total: formatBRL(e.total), reason: e.reason ?? null, receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id) })),
    };
  }
  if (input.action === "receipt") {
    if (typeof input.receipt_id !== "string") throw new Error("codespar_ledger: receipt_id is required for action=receipt");
    const owner = ctx.engine.list().find((e) => e.outcomes.some((o) => o.receipt_id === input.receipt_id));
    if (!owner) return { found: false, message: "no receipt with that id in this mandate's executions" };
    const outcome = owner.outcomes.find((o) => o.receipt_id === input.receipt_id)!;
    const item = owner.items[outcome.index];
    return { found: true, receipt_id: outcome.receipt_id, state: owner.state, payee: item?.beneficiary, amount: item ? formatBRL(item.amount) : null, mandate_id: owner.mandate.id };
  }
  throw new Error(`codespar_ledger: unsupported action ${String(input.action)}`);
};

/**
 * Who moved the execution to `approved`: the person (`human`), the signed
 * allowance (`mandate`), or nobody yet (`null`). The model is told which
 * approval modes exist but not which one ran, and without this it guesses.
 *
 * A kit approval forwarded to a platform proposal (codespar-test) is nobody's
 * decision about the payment: `null` until the proposal settles, which only
 * happens once the person paid it, and `human` from then on.
 */
export function approvedBy(execution: Execution): "human" | "mandate" | null {
  const step = execution.history.find((h) => h.to === "approved");
  if (!step) return null;
  if (forwardedToProposal(execution)) return execution.state === "settled" ? "human" : null;
  return step.actor.type === "human" ? "human" : "mandate";
}
