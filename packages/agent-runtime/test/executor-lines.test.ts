/**
 * ent#1983 on the console: after an execution ran, the executor the API
 * recorded, and on an executor refusal the line saying what to do, after the
 * API's own code and words (which `transitionLine` already prints).
 */
import { CORE_STRINGS, type Execution } from "@codespar/agent-core";
import { describe, expect, it } from "vitest";
import type { Setup } from "../src/setup.js";
import { executorLines } from "../src/terminal.js";

const setup = (locale: "pt-BR" | "en") => ({ coreStrings: CORE_STRINGS[locale] }) as unknown as Setup;

function execution(over: Partial<Execution>): Execution {
  return { state: "settled", outcomes: [], ...over } as Execution;
}

describe("executorLines", () => {
  it("a payment the simulator settled names it, with the API's label", () => {
    const settled = execution({ outcomes: [{ index: 0, attempt_id: "att_0", status: "settled", receipt_id: "rcpt_1", executor: "codespar_simulator" }] });
    expect(executorLines(settled, setup("pt-BR"))).toEqual(["  executado por: Simulado pela CodeSpar (codespar_simulator)"]);
    expect(executorLines(settled, setup("en"))).toEqual(["  executed by: Simulado pela CodeSpar (codespar_simulator)"]);
  });

  it("the provider's sandbox reads as its own label", () => {
    const settled = execution({ outcomes: [{ index: 0, attempt_id: "att_0", status: "settled", executor: "celcoin_sandbox" }] });
    expect(executorLines(settled, setup("pt-BR"))).toEqual(["  executado por: Integrado (sandbox Celcoin) (celcoin_sandbox)"]);
  });

  it("a Test mandate signed without an executor: the line says to sign a new one naming it", () => {
    const failed = execution({ state: "failed", reason: "rail_failed", outcomes: [{ index: 0, attempt_id: "att_0", status: "failed", code: "funding_source_executor_required", message: "signed without an executor" }] });
    const [line] = executorLines(failed, setup("pt-BR"));
    expect(line).toMatch(/assinado sem executor/);
    expect(line).toMatch(/npm run consent -- --yes/);
    expect(line).toMatch(/nada foi enviado/);
    expect(executorLines(failed, setup("en"))[0]).toMatch(/signed without an executor/);
  });

  it("nothing when the rail named no executor and nothing an executor fixes failed", () => {
    expect(executorLines(execution({ outcomes: [{ index: 0, attempt_id: "att_0", status: "settled" }] }), setup("pt-BR"))).toEqual([]);
    const failed = execution({ state: "failed", reason: "rail_failed", outcomes: [{ index: 0, attempt_id: "att_0", status: "failed", code: "insufficient_funds", message: "wallet" }] });
    expect(executorLines(failed, setup("pt-BR"))).toEqual([]);
  });
});
