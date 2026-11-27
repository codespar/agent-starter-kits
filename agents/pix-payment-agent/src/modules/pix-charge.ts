/**
 * The tool handlers the model can reach. `codespar_charge` hands the proposal to the engine and gets an execution in
 * `drafted` (then whatever the core decided); it cannot issue anything. `list_orders` is a read. The charge is the order's:
 * one item, for the amount the model passed, due today, and the order policy refuses any amount that is not the order's
 * total. The real call is built by the rail from the execution the core approved: on the integrated Test a platform
 * receive proposal the person sends (CONTRATO v1.6), on the stub rail a simulated charge.
 */
import type { Execution, PaymentRail, ToolHandler } from "@codespar/agent-core";
import { chargeProposalAwaiting } from "@codespar/agent-runtime";
import { ORDERS, formatBRL, orderByAlias, orderNumber } from "../orders.js";
import { STRINGS } from "../strings.js";
import type { Locale } from "@codespar/agent-core";

interface ChargeInput {
  action?: unknown;
  order?: unknown;
  amount_minor?: unknown;
  total_minor?: unknown;
  execution_id?: unknown;
}

export function makeHandlers(locale: () => Locale = () => "pt-BR", rail: Pick<PaymentRail, "name"> = { name: "stub-charge" }): Record<string, ToolHandler> {
  const listOrders: ToolHandler = async (_input, ctx) => {
    const text = STRINGS[locale()];
    const aliasesOf = (list: Execution[]) => new Set(list.flatMap((e) => e.items.map((i) => i.alias)).filter(Boolean));
    const paid = aliasesOf(ctx.engine.list({ state: "settled" }));
    const issued = aliasesOf(ctx.engine.list({ state: "executing" }));
    // Issued, then its reference turned ambiguous: the charge exists and may be paid; the core refuses another until it is reconciled.
    const unreconciled = aliasesOf(ctx.engine.list({ state: "failed" }).filter((e) => e.reason === "charge_reference_ambiguous"));
    return {
      today: ctx.engine.today(),
      orders: ORDERS.map((o) => ({
        alias: o.alias,
        customer_first_name: o.first_name,
        item: o.item,
        total_minor: o.total_minor,
        total: formatBRL(o.total_minor),
        status: paid.has(o.alias) ? text.statusPaid : issued.has(o.alias) ? text.statusIssued : unreconciled.has(o.alias) ? text.statusUnreconciled : text.statusOpen,
      })),
    };
  };

  const codesparCharge: ToolHandler = async (raw, ctx) => {
    const input = raw as ChargeInput;
    const action = input.action ?? "create";
    if (action === "status") {
      if (typeof input.execution_id !== "string") throw new Error("codespar_charge: execution_id is required for action=status");
      const execution = ctx.engine.get(input.execution_id);
      if (!execution) return { found: false, message: "no execution with that id in this run" };
      return { found: true, ...describe(execution, rail) };
    }
    if (action !== "create") throw new Error(`codespar_charge: unsupported action ${String(action)}; this agent only creates and reads Pix charges`);
    if (typeof input.order !== "string" || !input.order.trim()) throw new Error("codespar_charge: order must be an order alias from list_orders");
    if (typeof input.amount_minor !== "number" || !Number.isInteger(input.amount_minor) || input.amount_minor <= 0) throw new Error("codespar_charge: amount_minor must be a positive integer (BRL cents)");
    const alias = input.order.trim().toLowerCase();
    const order = orderByAlias(alias);
    const items = [{ payee: alias, amount: input.amount_minor, due_date: ctx.engine.today(), description: `Pedido ${orderNumber(alias)}${order ? ` - ${order.item}` : ""}` }];
    const claimed = typeof input.total_minor === "number" ? { claimed_total: input.total_minor } : {};

    const draft = await ctx.engine.draft({ items, ...claimed });
    if (!draft.ok) {
      // Refused before a draft: no execution will ever say so, and the run's count is taken from this.
      ctx.onNotRun?.({ ref: alias, why: "refused", detail: draft.reason });
      return { status: "refused", reason: draft.reason, message: draft.message, issued: false, paid: false };
    }
    const execution = await ctx.onExecution(draft.execution);
    return describe(execution, rail);
  };

  return { codespar_charge: codesparCharge, list_orders: listOrders };
}

function describe(execution: Execution, rail: Pick<PaymentRail, "name">) {
  // Hosted on codespar-test the charge is a platform proposal: a person sends it on its card, then the payer pays (v1.6).
  const awaiting = chargeProposalAwaiting(execution, rail);
  const outcome = execution.outcomes[0];
  const charge = outcome
    ? {
        charge_id: outcome.transaction_id ?? null,
        status: outcome.status,
        ...(outcome.instrument ? { payable: outcome.instrument.payable, pix_copy_paste: outcome.instrument.pix_copy_paste, due_date: outcome.instrument.due_date } : {}),
        ...(outcome.code ? { code: outcome.code } : {}),
      }
    : null;
  return {
    status: execution.state,
    execution_id: execution.id,
    total_minor: execution.total,
    total: formatBRL(execution.total),
    ...(execution.reason ? { reason: execution.reason, detail: execution.detail } : {}),
    ...(execution.escalation ? { escalated_by: execution.escalation.trigger } : {}),
    charge,
    // A charge proposal nobody sent yet is not issued: nothing reached the customer.
    issued: awaiting === "person_sends_charge_on_proposal" ? false : execution.reason === "charge_reference_ambiguous" ? execution.state === "failed" : charge !== null && charge.status !== "failed",
    ...(execution.reason === "charge_reference_ambiguous" ? { reconcile_before_reissue: true } : {}),
    paid: execution.state === "settled",
    expired: execution.state === "failed" && execution.reason === "charge_expired",
    ...(awaiting ? { awaiting } : {}),
  };
}
