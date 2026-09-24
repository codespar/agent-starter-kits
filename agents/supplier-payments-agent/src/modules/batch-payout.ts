/**
 * Module `batch-payout`. Section 2 of the spec, in one sentence: "um lote e
 * um laco de execucoes sob um mandato, com um `attempt_id` por chamada: uma
 * recusa nao derruba as outras, e repetir nao paga duas vezes."
 *
 * So a batch is N executions, not one execution of N items. The difference
 * is not stylistic. A multi-item execution settles only when EVERY attempt
 * settles, and its dispatch loop stops at the first refusal: measured on the
 * stub rail with a four-line payout whose second payee the rail declined,
 * the execution ended `failed`, one payee had been paid, and the two after
 * the refused one were never dispatched at all. That is the opposite of what
 * a payroll needs. One execution per line gives each line its own
 * `idempotency_key`, its own `attempt_id`, its own approval artifact with
 * its own `items_hash`, and its own terminal state, so a refusal is a fact
 * about ONE payee.
 *
 * The three properties this module owns, and where each one lives:
 *
 *   one refusal does not stop the others  -> the loop `continue`s, never
 *                                            breaks, and never throws past
 *                                            the line it is on
 *   one attempt_id per call               -> the core derives it from each
 *                                            execution's own idempotency key
 *   repeating pays nobody twice           -> the claim below
 *
 * The claim is what survives a re-run. Execution ids are random, so a second
 * run of the same batch would mint fresh ids, fresh idempotency keys and
 * fresh attempt ids, and the rail's own idempotence — which is keyed on
 * `attempt_id` — would not recognise them. The claim pairs (mandate, batch,
 * line) with the execution that covers it, durably, and the rules for
 * reading one back are the same posture the enterprise money paths take: a
 * line whose execution SETTLED is done, a line whose execution is still open
 * is in progress and is never re-opened, and only a line whose execution
 * ended without moving money is retried.
 */
import { isTerminal, type Execution, type ToolContext } from "@codespar/agent-core";
import { batchTotal, formatBRL, type Batch, type PayableLine } from "../payables.js";

/** What happened to one line of the batch. `dispatch` is the part an operator reads first. */
export interface BatchLineReport {
  alias: string;
  beneficiary: string;
  amount: string;
  amount_minor: number;
  execution_id: string | null;
  state: string;
  reason: string | null;
  /** Whether this line's money moved, could not move, or was deliberately not attempted again. */
  dispatch: "settled" | "refused" | "awaiting_decision" | "uncertain" | "already_settled" | "in_progress";
}

export interface BatchReport {
  batch: string;
  label: string;
  lines: BatchLineReport[];
  settled_minor: number;
  settled: string;
  /** Lines that did not settle, by alias. The receipt of a batch says which failed. */
  failed: string[];
  /** Lines a previous run of this batch already covers. */
  skipped: string[];
  total_minor: number;
  total: string;
}

/**
 * `claim:` is prefixed by the engine; what this module owns is everything
 * after it. The mandate is part of the key because a cursor is global to the
 * state file while an execution is not: two mandates may run a batch of the
 * same name and must not read each other's claims.
 */
function claimKey(mandateId: string, batchRef: string, alias: string): string {
  return `batch:${mandateId}:${batchRef}:${alias}`;
}

/**
 * What a claim already held means for this line: skip it, or drop it and
 * pay. `undefined` means nothing is held and the line is paid normally.
 */
function priorVerdict(prior: Execution | undefined): "already_settled" | "in_progress" | undefined {
  // A claim naming an execution the store does not have is a claim taken by a
  // run that died before it drafted. Nothing moved, so the line is open.
  if (!prior) return undefined;
  if (prior.state === "settled") return "already_settled";
  // Open: it may yet reach the rail, or may already have. A second execution
  // for the same line is how a payee gets paid twice; the operator closes the
  // first one with `npm run approve`, `npm run resume` or `npm run reconcile`.
  if (!isTerminal(prior.state)) return "in_progress";
  // `denied`, `expired`, `failed`: the core refused it or the rail declined
  // it, and in every one of those the money provably did not move. Retry.
  return undefined;
}

function dispatchOf(execution: Execution): BatchLineReport["dispatch"] {
  if (execution.state === "settled") return "settled";
  if (execution.state === "awaiting_approval") return "awaiting_decision";
  // Still `executing` after the channel ran it: the rail did not say. Never
  // re-sent here; `npm run reconcile` is what closes it.
  if (execution.state === "executing") return "uncertain";
  return "refused";
}

/**
 * Runs the batch. Every exit from an individual line is a `continue`: a
 * refusal, a claim already held, even a malformed line is a fact recorded
 * about that line and about nothing else.
 */
export async function runBatch(batch: Batch, ctx: ToolContext): Promise<BatchReport> {
  const mandateId = ctx.engine.mandate.id;
  const lines: BatchLineReport[] = [];

  for (const line of batch.lines) {
    const key = claimKey(mandateId, batch.ref, line.alias);
    const held = ctx.engine.claimed(key);
    if (held) {
      const prior = ctx.engine.get(held);
      const verdict = priorVerdict(prior);
      if (verdict) {
        lines.push({ ...describe(line), execution_id: held, state: prior?.state ?? "unknown", reason: null, dispatch: verdict });
        continue;
      }
    }

    const draft = await ctx.engine.draft({
      items: [{ payee: line.alias, amount: line.amount_minor, description: `${batch.label}: ${line.reference}`, due_date: batch.due }],
    });
    if (!draft.ok) {
      // Refused before an execution exists: nothing to claim, and the next
      // run of this batch tries the line again, which is right — the mandate
      // may have been re-signed by then.
      lines.push({ ...describe(line), execution_id: null, state: "refused_before_draft", reason: draft.reason, dispatch: "refused" });
      continue;
    }

    // Claimed BEFORE the channel can run it, so a crash between here and the
    // rail leaves a claim on an OPEN execution, which the rule above reads as
    // "in progress" and refuses to duplicate. Claiming after would leave a
    // settled payment unclaimed, and that is the double payment.
    ctx.engine.claim(key, draft.execution.id);
    try {
      const execution = await ctx.onExecution(draft.execution);
      lines.push({ ...describe(line), execution_id: execution.id, state: execution.state, reason: execution.reason ?? null, dispatch: dispatchOf(execution) });
    } catch (err) {
      // The channel threw. Nothing about the siblings changed, so the batch
      // carries on — a throw that escaped this loop would cancel every line
      // after it, which is the failure this module exists to not have. The
      // line is reported `uncertain` and NOT as a refusal, because a throw
      // does not say whether the rail was reached; the claim is already
      // taken, so the next run reads the execution's state and refuses to
      // open a second one while it is still open.
      const current = ctx.engine.get(draft.execution.id);
      lines.push({
        ...describe(line),
        execution_id: draft.execution.id,
        state: current?.state ?? draft.execution.state,
        reason: err instanceof Error ? err.message : String(err),
        dispatch: "uncertain",
      });
    }
  }

  const settledMinor = lines.filter((l) => l.dispatch === "settled").reduce((sum, l) => sum + l.amount_minor, 0);
  const total = batchTotal(batch);
  return {
    batch: batch.ref,
    label: batch.label,
    lines,
    settled_minor: settledMinor,
    settled: formatBRL(settledMinor),
    failed: lines.filter((l) => l.dispatch === "refused" || l.dispatch === "uncertain").map((l) => l.alias),
    skipped: lines.filter((l) => l.dispatch === "already_settled" || l.dispatch === "in_progress").map((l) => l.alias),
    total_minor: total,
    total: formatBRL(total),
  };
}

function describe(line: PayableLine): Pick<BatchLineReport, "alias" | "beneficiary" | "amount" | "amount_minor"> {
  return { alias: line.alias, beneficiary: line.name, amount: formatBRL(line.amount_minor), amount_minor: line.amount_minor };
}

/**
 * What a previous run of this batch left on one line, for the read tool. The
 * same claim the loop reads, so what the model is told and what the loop
 * would do cannot drift.
 */
export function lineStatus(batch: Batch, line: PayableLine, ctx: ToolContext): "open" | "already_settled" | "in_progress" {
  const held = ctx.engine.claimed(claimKey(ctx.engine.mandate.id, batch.ref, line.alias));
  if (!held) return "open";
  return priorVerdict(ctx.engine.get(held)) ?? "open";
}
