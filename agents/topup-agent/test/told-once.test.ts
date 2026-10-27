/**
 * "Check at your bank" is said once, whichever path says it: the kit's text
 * in an open window, or the poll's template once the window shut. Both take
 * the same once-only key, so the second path finds it taken.
 */
import { describe, expect, it } from "vitest";
import { toldKey } from "@codespar/agent-runtime";
import type { Execution } from "@codespar/agent-core";
import { agent } from "../src/kit.js";

describe("an execution stopped at a human is told once", () => {
  it("the kit's text takes the key the poll's template path checks, so the template is not sent after it", () => {
    const told = new Set<string>();
    const markTold = (id: string, key: string) => (told.has(`${id}:${key}`) ? false : (told.add(`${id}:${key}`), true));
    const setup = { locale: "pt-BR", engine: { markTold, note: () => undefined } };
    const execution = { id: "exe_1", state: "executing", reason: "rail_needs_human", detail: "pull_dispatch_uncertain", outcomes: [] } as unknown as Execution;

    const lines: string[] = [];
    expect(agent.kit.announceOutcome!(execution, setup as never, (l) => void lines.push(l))).toBe(true);
    expect(lines).toHaveLength(1);
    // What poll-whatsapp's template path asks before sending: already taken.
    expect(markTold(execution.id, toldKey(execution))).toBe(false);
    // And the kit does not say it again either.
    expect(agent.kit.announceOutcome!(execution, setup as never, (l) => void lines.push(l))).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it("the key is the state for every other outcome", () => {
    expect(toldKey({ state: "settled" } as Execution)).toBe("settled");
    expect(toldKey({ state: "executing", reason: "rail_uncertain" } as Execution)).toBe("executing");
    expect(toldKey({ state: "executing", reason: "rail_needs_human" } as Execution)).toBe("needs_human");
  });
});
