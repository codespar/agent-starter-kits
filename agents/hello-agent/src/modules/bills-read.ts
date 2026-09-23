/**
 * Module `bills-read`: the one tool handler the model can reach. It reads;
 * it cannot draft, approve or pay. There is no payment handler in this agent
 * on purpose, so no model output has a path to `ExecutionEngine.draft`.
 */
import type { ToolHandler } from "@codespar/agent-core";
import { BILLS, MONTH, formatBRL } from "../month.js";

export const listBills: ToolHandler = async (_input, ctx) => {
  const settled = ctx.engine.list({ state: "settled" });
  const paidAliases = new Set(settled.flatMap((e) => e.items.map((i) => i.alias)).filter(Boolean));
  const total = BILLS.reduce((sum, b) => sum + b.amount_minor, 0);
  return {
    month: MONTH,
    bills: BILLS.map((b) => ({ ...b, amount: formatBRL(b.amount_minor), paid_this_window: paidAliases.has(b.alias) })),
    total_minor: total,
    total: formatBRL(total),
    payees: ctx.engine.mandate.beneficiaries.map((b) => ({ alias: b.alias, name: b.name })),
    can_pay: false,
  };
};
