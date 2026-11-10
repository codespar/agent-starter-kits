/**
 * Who executes a Test payment, chosen at the consent before anyone signs
 * (codespar-enterprise ent#1983). A Test mandate pays from one of two
 * executors, named on `POST /v1/consents` as `executor`:
 *
 * - `codespar_simulator`: "Simulado pela CodeSpar". No KYC, no bank account,
 *   no provider called; the payment answers `moneyMoved: false`.
 * - `provider_sandbox`: the provider's sandbox account bound to the consumer
 *   in the project ("Integrado (sandbox Celcoin)" today). When the project is
 *   not ready the API answers 409 `provider_sandbox_not_ready` and creates
 *   nothing; it never falls back to the simulator, and neither does a kit.
 *
 * Live never simulates (`simulation_refused_live`). The labels below are the
 * API's own words for each recorded executor, shown as the API sends them
 * whatever the run's locale.
 */

/** What a consent asks for. */
export type ConsentExecutor = "codespar_simulator" | "provider_sandbox";

/** What the API records a payment as executed by (`payment.executor`, the consent's `executor`). */
export const EXECUTOR_LABELS: Readonly<Record<string, string>> = {
  codespar_simulator: "Simulado pela CodeSpar",
  celcoin_sandbox: "Integrado (sandbox Celcoin)",
};

/** The recorded executor a consent's choice resolves to. */
export const RECORDED_EXECUTOR: Readonly<Record<ConsentExecutor, string>> = {
  codespar_simulator: "codespar_simulator",
  provider_sandbox: "celcoin_sandbox",
};

/** The API's label for a recorded executor; an executor this kit does not know reads as its own name. */
export function executorLabel(executor: string): string {
  return EXECUTOR_LABELS[executor] ?? executor;
}

/** The executor the settled attempts of an execution ran on, or null when the rail named none. */
export function executorOf(execution: { outcomes: ReadonlyArray<{ executor?: string }> }): string | null {
  return execution.outcomes.find((o) => o.executor)?.executor ?? null;
}

/** The refusal codes ent#1983 adds that a person can act on, each with a line in `CoreStrings.executorHint`. */
export const EXECUTOR_REFUSAL_CODES = ["funding_source_executor_required", "simulation_refused_live", "executor_test_only", "provider_sandbox_not_ready"] as const;
export type ExecutorRefusalCode = (typeof EXECUTOR_REFUSAL_CODES)[number];

export function isExecutorRefusal(code: string | undefined | null): code is ExecutorRefusalCode {
  return (EXECUTOR_REFUSAL_CODES as readonly string[]).includes(code ?? "");
}
