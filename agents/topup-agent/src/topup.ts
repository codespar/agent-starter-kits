/**
 * The tool handlers the model can reach. `codespar_charge` hands the proposal
 * to the engine and gets an execution in `drafted` (then whatever the core
 * decided); it cannot ask the bank for anything. `account_status` is a read.
 * The bank calls (the authorization, then the one payment) are made by the
 * rail, from the execution the core approved.
 */
import { formatBRL, type Execution, type Locale, type ToolHandler } from "@codespar/agent-core";
import { STRINGS } from "./strings.js";

/** The one account this agent tops up: the mandate's single beneficiary. */
export const ACCOUNT_ALIAS = "minha-conta";

interface ChargeInput {
  action?: unknown;
  account?: unknown;
  amount_minor?: unknown;
  total_minor?: unknown;
  execution_id?: unknown;
}

export function makeHandlers(locale: () => Locale = () => "pt-BR"): Record<string, ToolHandler> {
  const accountStatus: ToolHandler = async (_input, ctx) => {
    const mandate = ctx.engine.mandate;
    const account = mandate.beneficiaries[0];
    const settled = ctx.engine.list({ state: "settled" });
    const pulled = settled.reduce((sum, e) => sum + e.total, 0);
    const waiting = ctx.engine.list({ state: "executing" });
    return {
      today: ctx.engine.today(),
      account: account ? { alias: account.alias, name: account.name } : null,
      source_bank: STRINGS[locale()].bankName,
      per_pull_limit_minor: mandate.per_tx_cap_minor,
      per_pull_limit: formatBRL(mandate.per_tx_cap_minor, locale()),
      total_limit_minor: mandate.cap_minor,
      total_limit: formatBRL(mandate.cap_minor, locale()),
      pulled_minor: pulled,
      pulled: formatBRL(pulled, locale()),
      waiting_for_bank: waiting.map((e) => ({ execution_id: e.id, amount: formatBRL(e.total, locale()) })),
    };
  };

  const codesparCharge: ToolHandler = async (raw, ctx) => {
    const input = raw as ChargeInput;
    const action = input.action ?? "create";
    if (action === "status") {
      if (typeof input.execution_id !== "string") throw new Error("codespar_charge: execution_id is required for action=status");
      const execution = ctx.engine.get(input.execution_id);
      if (!execution) return { found: false, message: "no execution with that id in this run" };
      return { found: true, ...describe(execution, locale()) };
    }
    if (action !== "create") throw new Error(`codespar_charge: unsupported action ${String(action)}; this agent only proposes and reads pulls`);
    if (typeof input.amount_minor !== "number" || !Number.isInteger(input.amount_minor) || input.amount_minor <= 0) throw new Error("codespar_charge: amount_minor must be a positive integer (BRL cents)");
    const account = typeof input.account === "string" && input.account.trim() ? input.account.trim().toLowerCase() : ACCOUNT_ALIAS;
    const claimed = typeof input.total_minor === "number" ? { claimed_total: input.total_minor } : {};
    const draft = await ctx.engine.draft({ items: [{ payee: account, amount: input.amount_minor, description: "Recarga CodeSpar via Open Finance" }], ...claimed });
    if (!draft.ok) {
      ctx.onNotRun?.({ ref: account, why: "refused", detail: draft.reason });
      return { status: "refused", reason: draft.reason, message: draft.message, pulled: false, paid: false };
    }
    const execution = await ctx.onExecution(draft.execution);
    return describe(execution, locale());
  };

  return { codespar_charge: codesparCharge, account_status: accountStatus };
}

export function endToEndOf(execution: Execution): string | null {
  if (execution.state !== "settled") return null;
  return execution.outcomes.find((o) => o.status === "settled")?.transaction_id ?? null;
}

function describe(execution: Execution, locale: Locale) {
  const outcome = execution.outcomes[0];
  return {
    status: execution.state,
    execution_id: execution.id,
    amount_minor: execution.total,
    amount: formatBRL(execution.total, locale),
    ...(execution.reason ? { reason: execution.reason, detail: execution.detail } : {}),
    ...(execution.escalation ? { escalated_by: execution.escalation.trigger } : {}),
    // The consent link goes to the person from the code, never through the model: it only needs to know the bank was asked.
    bank_asked: outcome !== undefined,
    waiting_for_bank: execution.state === "executing",
    paid: execution.state === "settled",
    end_to_end_id: endToEndOf(execution),
    expired: execution.state === "failed" && execution.reason === "charge_expired",
    declined_at_bank: execution.state === "failed" && execution.reason === "charge_cancelled",
  };
}
