/**
 * The three properties the `batch-payout` capability exists to have. Each
 * one is asserted on the state machine, not on what the report says about
 * itself: a batch that reports "already_settled" while quietly drafting a
 * second execution would pass a report check and fail this one.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock, type Execution, type ToolContext } from "@codespar/agent-core";
import { setup, type Setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { runBatch } from "../src/modules/batch-payout.js";
import { findBatch } from "../src/payables.js";

const APPROVER = { id: "usr_demo_financeiro", channel: "terminal" };
const runsDir = mkdtempSync(join(tmpdir(), "supplier-batch-runs-"));

/** What the terminal channel does to each execution, without the terminal. */
function approveAndRun(s: Setup): ToolContext["onExecution"] {
  return async (execution: Execution) => {
    let current = execution;
    if (current.state === "awaiting_approval") current = s.engine.approve(current.id, APPROVER);
    if (current.state === "approved") current = await s.engine.execute(current.id);
    return current;
  };
}

function open(stateDir: string, options: { refusePayees?: string[] } = {}): Setup {
  return setup(agent, {
    mode: "human",
    rail: "stub",
    provider: "replay",
    runsDir,
    stateDir,
    now: fixedClock("2026-09-23T14:00:00-03:00"),
    ...(options.refusePayees ? { stubRail: { refusePayees: options.refusePayees } } : {}),
    say: () => undefined,
  });
}

async function run(s: Setup, ref: string) {
  const batch = findBatch(ref)!;
  return runBatch(batch, { engine: s.engine, onExecution: approveAndRun(s) });
}

describe("batch-payout: a batch is a loop of executions", () => {
  it("runs one execution per line, each with its own attempt and its own approval artifact", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-batch-a-")));
    try {
      const report = await run(s, "folha-2026-10");
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "settled", "settled"]);
      expect(report.settled_minor).toBe(540000);

      const executions = s.engine.list();
      expect(executions).toHaveLength(3);
      // One line each: the whole point, since a four-item execution would be one row.
      for (const e of executions) expect(e.items).toHaveLength(1);
      // One attempt id per call, and no two lines share one.
      const attempts = executions.flatMap((e) => e.outcomes.map((o) => o.attempt_id));
      expect(new Set(attempts).size).toBe(3);
      // The approved list is attested line by line, each hash bound to the same mandate version.
      const artifacts = s.bundle.readApprovals();
      expect(artifacts).toHaveLength(3);
      expect(new Set(artifacts.map((a) => a.items_hash)).size).toBe(3);
      for (const a of artifacts) {
        expect(a.approver.type).toBe("person");
        expect(a.mandate).toEqual({ id: s.mandate.id, version: s.mandate.version });
      }
      expect(artifacts.map((a) => a.execution_id).sort()).toEqual(executions.map((e) => e.id).sort());
    } finally {
      s.close();
    }
  });

  it("one refusal does not stop the others: the lines after the refused one still dispatch", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-batch-b-")), { refusePayees: ["contas@insumos-atlantico.example.com.br"] });
    try {
      const report = await run(s, "fornecedores-2026-10");
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "refused", "settled"]);
      expect(report.failed).toEqual(["insumos"]);
      expect(report.settled_minor).toBe(174000);
      // The refused line is a terminal state of its OWN execution, and the
      // third line — the one after it — reached the rail all the same.
      expect(s.engine.list().map((e) => e.state)).toEqual(["settled", "failed", "settled"]);
      const third = s.engine.list()[2]!;
      expect(third.outcomes.map((o) => o.status)).toEqual(["settled"]);
    } finally {
      s.close();
    }
  });

  it("repeating the batch pays nobody twice, and opens no second execution", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "supplier-batch-c-"));
    const first = open(stateDir);
    let firstIds: string[];
    try {
      await run(first, "comissoes-2026-10");
      firstIds = first.engine.list().map((e) => e.id);
      expect(firstIds).toHaveLength(2);
    } finally {
      first.close();
    }

    // A second process, a second run id, the same state file: what a re-run is.
    const second = open(stateDir);
    try {
      const report = await run(second, "comissoes-2026-10");
      expect(report.lines.map((l) => l.dispatch)).toEqual(["already_settled", "already_settled"]);
      expect(report.settled_minor).toBe(0);
      expect(report.skipped).toEqual(["rep-sul", "rep-norte"]);
      // Nothing new was drafted, so nothing new could be dispatched.
      expect(second.engine.list().map((e) => e.id)).toEqual(firstIds);
      expect(report.lines.map((l) => l.execution_id)).toEqual(firstIds);
    } finally {
      second.close();
    }
  });

  it("a line whose execution ended without moving money is retried; one still open is not", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "supplier-batch-d-"));
    // The rail refuses one supplier, so that line ends `failed`: money provably did not move.
    const first = open(stateDir, { refusePayees: ["contas@insumos-atlantico.example.com.br"] });
    try {
      await run(first, "fornecedores-2026-10");
    } finally {
      first.close();
    }

    const second = open(stateDir);
    try {
      const report = await run(second, "fornecedores-2026-10");
      // The two that settled are skipped; the one that failed is paid now.
      expect(report.lines.map((l) => l.dispatch)).toEqual(["already_settled", "settled", "already_settled"]);
      expect(report.settled_minor).toBe(125000);
      expect(second.engine.list()).toHaveLength(4);
    } finally {
      second.close();
    }

    // A line left awaiting a decision is NOT retried: the dispatch may yet happen.
    const third = open(mkdtempSync(join(tmpdir(), "supplier-batch-e-")));
    try {
      const batch = findBatch("comissoes-2026-10")!;
      await runBatch(batch, { engine: third.engine, onExecution: async (e) => e });
      const report = await runBatch(batch, { engine: third.engine, onExecution: approveAndRun(third) });
      expect(report.lines.map((l) => l.dispatch)).toEqual(["in_progress", "in_progress"]);
      expect(third.engine.list()).toHaveLength(2);
    } finally {
      third.close();
    }
  });

  it("the lines of a batch come from the payables file, so a model cannot write them", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-batch-f-")));
    try {
      const pay = s.handlers["codespar_pay"]!;
      const ctx: ToolContext = { engine: s.engine, onExecution: approveAndRun(s) };
      await expect(
        pay({ action: "pix", batch_ref: "folha-2026-10", items: [{ payee: "ana", amount_minor: 1 }] }, ctx),
      ).rejects.toThrow(/batch_ref cannot be sent with items/);
      await expect(pay({ action: "pix", batch_ref: "folha-de-outubro" }, ctx)).rejects.toThrow(/unknown batch_ref/);
      // Neither refusal drafted anything.
      expect(s.engine.list()).toHaveLength(0);
    } finally {
      s.close();
    }
  });
});
