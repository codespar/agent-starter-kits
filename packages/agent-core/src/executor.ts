/**
 * Who executes a Test payment, chosen at the consent before anyone signs
 * (codespar-enterprise ent#1983). A Test mandate pays from one of two
 * executors, named on `POST /v1/consents` as `executor`:
 *
 * - `codespar_simulator`: "Simulado pela CodeSpar". No KYC, no bank account,
 *   no provider called; the payment answers `moneyMoved: false`.
 * - `provider_sandbox`: the provider's sandbox account bound to the consumer
 *   in the project. The provider, account, project and consumer are resolved
 *   by the server before the signature (`executor_provider` reports it); a
 *   request never names them (400 `executor_provider_not_selectable`). When the project is
 *   not ready the API answers 409 `provider_sandbox_not_ready` and creates
 *   nothing; it never falls back to the simulator, and neither does a kit.
 *
 * Live never simulates (`simulation_refused_live`). The labels below are the
 * API's own words for each recorded executor, shown as the API sends them
 * whatever the run's locale.
 */

/** What a consent asks for. */
export type ConsentExecutor = "codespar_simulator" | "provider_sandbox";

/**
 * The executor's label, by the name the API answers. Since ent#1983's public
 * rename the API answers the same word the consent asked for
 * (`provider_sandbox`), with the provider apart (`executor_provider`); before
 * it, the provider's sandbox was answered `celcoin_sandbox`. Both are read.
 */
export const EXECUTOR_LABELS: Readonly<Record<string, string>> = {
  codespar_simulator: "Simulado pela CodeSpar",
  provider_sandbox: "Sandbox do provedor",
  celcoin_sandbox: "Integrado (sandbox Celcoin)",
};

/** Said beside every Test executor, a sandbox that CONFIRMED the payment included (`real_money: false`). */
export const NO_REAL_MONEY = "sem dinheiro real";

/** The name the API answered before ent#1983's public rename, for a consent's choice. */
export const RECORDED_EXECUTOR: Readonly<Record<ConsentExecutor, string>> = {
  codespar_simulator: "codespar_simulator",
  provider_sandbox: "celcoin_sandbox",
};

/** The consent's choice an answered executor names (either spelling), or null for any other value. */
export function publicExecutor(answered: string | null | undefined): ConsentExecutor | null {
  if (answered === "codespar_simulator") return "codespar_simulator";
  if (answered === "provider_sandbox" || answered === "celcoin_sandbox") return "provider_sandbox";
  return null;
}

/** Whether the API's answer confirms the executor a consent asked for: the public name, or the one before the rename. */
export function confirmsExecutor(choice: ConsentExecutor, answered: string | null | undefined): boolean {
  return publicExecutor(answered) === choice;
}

/**
 * The API's label for an answered executor; an executor this kit does not know
 * reads as its own name. Both executors exist only in Test: a label that does
 * not say "sem dinheiro real" yet (an API before ent#1983) is completed.
 */
export function executorLabel(executor: string): string {
  const label = EXECUTOR_LABELS[executor] ?? executor;
  return publicExecutor(executor) ? withNoRealMoney(label) : label;
}

/** A Test executor's label with "sem dinheiro real", never doubled. */
export function withNoRealMoney(label: string): string {
  return /sem dinheiro real/i.test(label) ? label : `${label} · ${NO_REAL_MONEY}`;
}

/**
 * The provider behind an answered sandbox executor: the API's `executor_provider`
 * when it sent one, the provider the legacy name spelled, otherwise null.
 * Read-only: a kit never sends a provider (400 `executor_provider_not_selectable`).
 */
export function executorProvider(answer: { executor?: unknown; executor_provider?: unknown } | null | undefined): string | null {
  if (!answer) return null;
  if (typeof answer.executor_provider === "string" && answer.executor_provider) return answer.executor_provider;
  return answer.executor === "celcoin_sandbox" ? "celcoin" : null;
}

/** The executor the settled attempts of an execution ran on, or null when the rail named none. */
export function executorOf(execution: { outcomes: ReadonlyArray<{ executor?: string }> }): string | null {
  return execution.outcomes.find((o) => o.executor)?.executor ?? null;
}

/** The refusal codes ent#1983 adds that a person can act on, each with a line in `CoreStrings.executorHint`. */
export const EXECUTOR_REFUSAL_CODES = [
  "funding_source_executor_required",
  "simulation_refused_live",
  "executor_test_only",
  "provider_sandbox_not_ready",
  "executor_provider_not_selectable",
] as const;
export type ExecutorRefusalCode = (typeof EXECUTOR_REFUSAL_CODES)[number];

export function isExecutorRefusal(code: string | undefined | null): code is ExecutorRefusalCode {
  return (EXECUTOR_REFUSAL_CODES as readonly string[]).includes(code ?? "");
}
