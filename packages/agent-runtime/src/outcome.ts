/**
 * What a run did, counted from what the engine holds and not from what the
 * model said. A reply is the model's (or a recording's) and may claim a
 * payroll ran when every line was already paid or every line failed; this is
 * the line the terminal prints after it, and the one-shot's exit code.
 */
import { isReplayedSettlement, isTerminal, type CoreStrings, type Execution, type NotRunLine } from "@codespar/agent-core";

export interface RunOutcome {
  /** Executions this run settled. */
  settled: number;
  /** Executions that ended `failed` (other than a charge left unpaid), plus lines refused before a draft existed. */
  failed: number;
  /** Executions that ended `denied` or `expired`, or `failed` with `charge_expired`: somebody said no, or nobody answered or paid in time. */
  declined: number;
  /** Lines an earlier run already paid: skipped here, or answered by the API with the earlier payment. */
  already_paid: number;
  /** Executions not yet terminal, plus lines an earlier, still open execution holds. */
  open: number;
}

export function runOutcome(executions: readonly Execution[], notRun: readonly NotRunLine[]): RunOutcome {
  const out: RunOutcome = { settled: 0, failed: 0, declined: 0, already_paid: 0, open: 0 };
  for (const e of executions) {
    if (isReplayedSettlement(e)) out.already_paid += 1;
    else if (e.state === "settled") out.settled += 1;
    // A charge nobody paid in time closes `failed`, but nothing failed: it is counted with the expired.
    else if (e.state === "failed" && e.reason !== "charge_expired") out.failed += 1;
    else if (isTerminal(e.state)) out.declined += 1;
    else out.open += 1;
  }
  for (const line of notRun) {
    if (line.why === "already_settled") out.already_paid += 1;
    else if (line.why === "refused") out.failed += 1;
    else out.open += 1;
  }
  return out;
}

export function outcomeLine(text: CoreStrings, outcome: RunOutcome): string {
  return text.runOutcome(outcome.settled, outcome.failed, outcome.declined, outcome.already_paid, outcome.open);
}

/**
 * The one-shot's exit code. 1 when an execution ended `failed` or a line was
 * refused before a draft. 0 otherwise: settled, already paid, still open, and
 * also `denied` or `expired`, which are the agent doing its job and are named
 * on the line. 3 (the caller's) stays what it was: an execution left
 * `executing`, whose outcome the rail did not say.
 */
export function outcomeExitCode(outcome: RunOutcome): 0 | 1 {
  return outcome.failed > 0 ? 1 : 0;
}
