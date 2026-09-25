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
import { fixedClock, maskPayee, type Execution, type ToolContext } from "@codespar/agent-core";
import { assembleTimeline, handleExecution, parseBatchGesture, presentBatch, setup, type BatchGestures, type Setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { runBatch } from "../src/modules/batch-payout.js";
import { findBatch, type Batch } from "../src/payables.js";

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

/**
 * A four-line batch, because "3 of 4" needs a fourth to be missing. Built
 * from the payables file's own lines so every payee is one the mandate names.
 */
function fourLines(ref = "quatro-linhas-2026-10"): Batch {
  const folha = findBatch("folha-2026-10")!;
  const fornecedores = findBatch("fornecedores-2026-10")!;
  return { ...folha, ref, label: "Quatro linhas de outubro", lines: [...folha.lines, fornecedores.lines[0]!] };
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

  it("every line presents the quote of its OWN approved line, and its receipt carries the payee that quote sealed (OPEN_QUESTIONS §18)", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-batch-q-")));
    try {
      await run(s, "folha-2026-10");
      const artifacts = s.bundle.readApprovals();
      for (const e of s.engine.list()) {
        const line = artifacts.find((a) => a.execution_id === e.id)!.items[0]!;
        const outcome = e.outcomes[0]!;
        const sent = s.store.stubRailGet(outcome.attempt_id)!.request as { quote?: { price_minor: number; payee: string; seller: string } };
        expect(sent.quote).toMatchObject({ seller: line.beneficiary, price_minor: line.amount, payee: line.payee });
        expect(s.bundle.readReceipt(`${outcome.receipt_id}.json`)?.["payment"]).toMatchObject({ payee: maskPayee(line.payee) });
      }
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

  it("a channel that throws on one line does not cancel the lines after it", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-batch-g-")));
    try {
      const run = approveAndRun(s);
      let seen = 0;
      const report = await runBatch(findBatch("folha-2026-10")!, {
        engine: s.engine,
        onExecution: async (e) => {
          seen += 1;
          if (seen === 2) throw new Error("channel exploded");
          return run(e);
        },
      });
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "uncertain", "settled"]);
      // The third line reached the rail, and the second is reported, not swallowed.
      expect(report.failed).toEqual(["bruno"]);
      expect(report.settled_minor).toBe(360000);
      // Its claim was taken before the throw, so a re-run will not open a second execution for it.
      const stuck = report.lines[1]!.execution_id!;
      const again = await runBatch(findBatch("folha-2026-10")!, { engine: s.engine, onExecution: run });
      expect(again.lines.map((l) => l.dispatch)).toEqual(["already_settled", "in_progress", "already_settled"]);
      expect(again.lines[1]!.execution_id).toBe(stuck);
    } finally {
      s.close();
    }
  });

  it("a line the core cannot read at all is one line's problem, not the batch's", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-batch-h-")));
    try {
      const batch = findBatch("comissoes-2026-10")!;
      // `draft` throws on a non-positive amount, which is a bug in the payables
      // file rather than a refusal. The second line must still be paid.
      const broken = { ...batch, lines: [{ ...batch.lines[0]!, amount_minor: 0 }, batch.lines[1]!] };
      const report = await runBatch(broken, { engine: s.engine, onExecution: approveAndRun(s) });
      expect(report.lines.map((l) => l.dispatch)).toEqual(["refused", "settled"]);
      expect(report.lines[0]!.state).toBe("unreadable_line");
      expect(report.settled_minor).toBe(48000);
    } finally {
      s.close();
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

/**
 * Issue #21: each line was already attested; this is the SET. A person who
 * approves four lines and gets three run must not be left with a bundle that
 * says nothing about the fourth. Two causes are separated here on purpose,
 * because they want opposite answers: a line the human DENIED is a decision
 * and is reported, and a line that left the LIST after the list was approved
 * is a changed set and is refused.
 */
describe("batch-payout: the approved list is bound as a set", () => {
  it("every artifact of a batch names the same list, and its own place in it", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-set-a-")));
    try {
      const batch = fourLines();
      const report = await runBatch(batch, { engine: s.engine, onExecution: approveAndRun(s) });
      expect(report.line_count).toBe(4);
      expect(report.lines.map((l) => l.index)).toEqual([0, 1, 2, 3]);
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "settled", "settled", "settled"]);

      const artifacts = s.bundle.readApprovals();
      expect(artifacts).toHaveLength(4);
      // One hash for the list, one position each. Before this, four artifacts
      // with four different items_hash values had nothing in common but a
      // mandate version, which three of them would also have had.
      expect(new Set(artifacts.map((a) => a.batch!.batch_hash))).toEqual(new Set([report.batch_hash]));
      expect(artifacts.map((a) => a.batch!.index)).toEqual([0, 1, 2, 3]);
      expect(artifacts.map((a) => a.batch!.count)).toEqual([4, 4, 4, 4]);
      expect(new Set(artifacts.map((a) => a.batch!.ref))).toEqual(new Set([batch.ref]));
      // Each line's own hash is still its own: the set binds them, it does not merge them.
      expect(new Set(artifacts.map((a) => a.items_hash)).size).toBe(4);
    } finally {
      s.close();
    }
  });

  it("a line dropped after the list was approved refuses the whole run, and drafts nothing", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "supplier-set-b-"));
    const four = fourLines();

    const first = open(stateDir);
    let approvedHash: string;
    try {
      const report = await runBatch(four, { engine: first.engine, onExecution: approveAndRun(first) });
      approvedHash = report.batch_hash;
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "settled", "settled", "settled"]);
    } finally {
      first.close();
    }

    // The third line leaves the payables file. Every surviving line would
    // answer `already_settled` on its own, so nothing per-line would notice.
    const three: Batch = { ...four, lines: four.lines.filter((_, i) => i !== 2) };
    const second = open(stateDir);
    try {
      const report = await runBatch(three, { engine: second.engine, onExecution: approveAndRun(second) });
      expect(report.refused).toEqual({
        reason: "batch_set_changed",
        detail: expect.stringContaining("is not the set in front of us"),
        approved_batch_hash: approvedHash,
        presented_batch_hash: report.batch_hash,
        approved_count: 4,
        presented_count: 3,
      });
      expect(report.batch_hash).not.toBe(approvedHash);
      // Refused as a SET: no line ran, and the counts are the list's own.
      expect(report.line_count).toBe(3);
      expect(report.lines.map((l) => l.dispatch)).toEqual(["refused", "refused", "refused"]);
      expect(report.lines.map((l) => l.state)).toEqual(["batch_set_changed", "batch_set_changed", "batch_set_changed"]);
      expect(report.settled_minor).toBe(0);
      // Nothing was drafted: the store still holds the four the first run made.
      expect(second.engine.list()).toHaveLength(4);
      // And the refusal is in the attested record, not only in the model's conversation.
      const refusals = second.bundle.readEvents().filter((e) => e["type"] === "batch.set_refused");
      expect(refusals).toHaveLength(1);
      expect((refusals[0]!["payload"] as Record<string, unknown>)["batch_ref"]).toBe(four.ref);
    } finally {
      second.close();
    }

    // The way out the refusal names: the new list runs under a ref of its own.
    const third = open(stateDir);
    try {
      const report = await runBatch({ ...three, ref: "quatro-linhas-2026-10-revisado" }, { engine: third.engine, onExecution: approveAndRun(third) });
      expect(report.refused).toBeUndefined();
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "settled", "settled"]);
      expect(report.line_count).toBe(3);
      expect(third.bundle.readApprovals().map((a) => a.batch!.count)).toEqual([3, 3, 3]);
    } finally {
      third.close();
    }
  });

  it("a line the human denied is named with its reason, and the counts still add to the four presented", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-set-c-")));
    try {
      const batch = fourLines();
      const decide = approveAndRun(s);
      let seen = 0;
      const report = await runBatch(batch, {
        engine: s.engine,
        onExecution: async (execution) => {
          seen += 1;
          // The operator reads line 3 and says no. That is what per-line
          // approval is FOR, so it is a decision and not a changed set.
          if (seen === 3) return s.engine.deny(execution.id, APPROVER, "esta linha nao e nossa");
          return decide(execution);
        },
      });

      expect(report.refused).toBeUndefined();
      expect(report.line_count).toBe(4);
      expect(report.lines).toHaveLength(4);
      const denied = report.lines[2]!;
      expect(denied.index).toBe(2);
      expect(denied.alias).toBe("carla");
      expect(denied.dispatch).toBe("refused");
      expect(denied.state).toBe("denied");
      expect(denied.reason).toBe("denied_by_approver");
      expect(report.failed).toEqual(["carla"]);
      // Three paid plus one denied is the four that were presented.
      expect(report.lines.filter((l) => l.dispatch === "settled")).toHaveLength(3);
      expect(report.settled_minor).toBe(batch.lines.reduce((sum, l) => sum + l.amount_minor, 0) - denied.amount_minor);

      // A denied line mints no artifact, so the set is what says a fourth existed.
      const artifacts = s.bundle.readApprovals();
      expect(artifacts.map((a) => a.batch!.index)).toEqual([0, 1, 3]);
      for (const a of artifacts) expect(a.batch!.count).toBe(4);

      // And inspect reads it back as exactly that: 3 of 4, with a fourth line
      // that HAS an execution and no approval artifact.
      const timeline = assembleTimeline(s.bundle);
      expect(timeline.batches).toHaveLength(1);
      const read = timeline.batches[0]!;
      expect(read).toMatchObject({ ref: batch.ref, batch_hash: report.batch_hash, count: 4, attested: 3, missing: [] });
      expect(read.lines.map((l) => [l.index, l.final_state, l.attested])).toEqual([
        [0, "settled", true],
        [1, "settled", true],
        [2, "denied", false],
        [3, "settled", true],
      ]);
    } finally {
      s.close();
    }
  });

  it("a batch that is not a batch is unchanged: a one-off payment carries no binding at all", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-set-d-")));
    try {
      const pay = s.handlers["codespar_pay"]!;
      await pay({ action: "pix", items: [{ payee: "grafica", amount_minor: 98000 }] }, { engine: s.engine, onExecution: approveAndRun(s) });
      const [execution] = s.engine.list();
      expect(execution!.state).toBe("settled");
      expect(execution!.batch).toBeUndefined();
      const [artifact] = s.bundle.readApprovals();
      expect("batch" in artifact!).toBe(false);
      expect(assembleTimeline(s.bundle).batches).toEqual([]);
    } finally {
      s.close();
    }
  });
});

/**
 * The interactive terminal's two hooks, driven by scripted answers: one
 * question for the list, then every line decided by what was answered.
 */
function gestureChannel(s: Setup, answers: string[]): { ctx: ToolContext; asked: string[] } {
  const gestures: BatchGestures = new Map();
  const asked: string[] = [];
  const ask = async (question: string) => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`asked more than scripted: ${question}`);
    return answer;
  };
  const options = { setup: s, approver: APPROVER, ask, say: () => undefined, gestures };
  return {
    asked,
    ctx: {
      engine: s.engine,
      onExecution: (execution) => handleExecution(execution, options),
      onBatch: (batch) => presentBatch(batch, options),
    },
  };
}

describe("batch-payout: one gesture approves the list, with a veto per line (§39e)", () => {
  it("reads todas, todas exceto and nenhuma, and refuses to guess at anything else", () => {
    expect(parseBatchGesture("todas", 4)).toEqual({ vetoed: [] });
    expect(parseBatchGesture("all", 4)).toEqual({ vetoed: [] });
    expect(parseBatchGesture("todas exceto 3", 4)).toEqual({ vetoed: [2] });
    expect(parseBatchGesture("all except 4, 1,4", 4)).toEqual({ vetoed: [0, 3] });
    expect(parseBatchGesture("nenhuma", 4)).toEqual({ vetoed: [0, 1, 2, 3] });
    expect(parseBatchGesture("", 4)).toEqual({ vetoed: [0, 1, 2, 3] });
    // A line that does not exist is a typo, and a typo must not veto nothing.
    expect(parseBatchGesture("todas exceto 5", 4)).toBeUndefined();
    expect(parseBatchGesture("todas exceto 0", 4)).toBeUndefined();
    expect(parseBatchGesture("s", 4)).toBeUndefined();
    expect(parseBatchGesture("todas menos 2", 4)).toBeUndefined();
  });

  it("approve-all is one question, and still mints one artifact per line, each naming the list", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-gesture-a-")));
    try {
      const batch = fourLines();
      const channel = gestureChannel(s, ["todas"]);
      const report = await runBatch(batch, channel.ctx);

      expect(channel.asked).toHaveLength(1);
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "settled", "settled", "settled"]);
      expect(report.gesture).toEqual({ batch_hash: report.batch_hash, approved: [0, 1, 2, 3], vetoed: [] });

      const artifacts = s.bundle.readApprovals();
      expect(artifacts).toHaveLength(4);
      expect(new Set(artifacts.map((a) => a.batch!.batch_hash))).toEqual(new Set([report.batch_hash]));
      expect(artifacts.map((a) => a.batch!.index)).toEqual([0, 1, 2, 3]);
      for (const a of artifacts) expect(a.approver).toEqual({ type: "person", id: APPROVER.id, channel: APPROVER.channel });

      // The gesture itself is in the attested record, next to the artifacts it produced.
      const gestures = s.bundle.readEvents().filter((e) => e["type"] === "batch.gesture");
      expect(gestures).toHaveLength(1);
      expect(gestures[0]!["payload"]).toMatchObject({ batch_ref: batch.ref, batch_hash: report.batch_hash, count: 4, approved: [0, 1, 2, 3], vetoed: [], approver: { type: "human", id: APPROVER.id } });
    } finally {
      s.close();
    }
  });

  it("approve-except denies exactly the vetoed lines, and the report says which", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-gesture-b-")));
    try {
      const batch = fourLines();
      const channel = gestureChannel(s, ["todas exceto 2,4"]);
      const report = await runBatch(batch, channel.ctx);

      expect(channel.asked).toHaveLength(1);
      expect(report.lines.map((l) => [l.index, l.dispatch, l.state])).toEqual([
        [0, "settled", "settled"],
        [1, "refused", "denied"],
        [2, "settled", "settled"],
        [3, "refused", "denied"],
      ]);
      const vetoed = [batch.lines[1]!.alias, batch.lines[3]!.alias];
      expect(report.denied).toEqual(vetoed);
      expect(report.failed).toEqual(vetoed);
      expect(report.gesture).toEqual({ batch_hash: report.batch_hash, approved: [0, 2], vetoed: [1, 3] });
      expect(report.settled_minor).toBe(batch.lines[0]!.amount_minor + batch.lines[2]!.amount_minor);

      // A vetoed line is a decision: it has an execution, no artifact, and says why.
      const artifacts = s.bundle.readApprovals();
      expect(artifacts.map((a) => a.batch!.index)).toEqual([0, 2]);
      const denied = s.engine.list().filter((e) => e.state === "denied");
      expect(denied.map((e) => e.batch!.index)).toEqual([1, 3]);
      expect(denied.map((e) => e.detail)).toEqual(["vetoed in the batch gesture (line 2 of 4)", "vetoed in the batch gesture (line 4 of 4)"]);
    } finally {
      s.close();
    }
  });

  it("a line that belongs to another list under the same ref is not approved by the gesture", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-gesture-c-")));
    try {
      const batch = fourLines();
      const gestures: BatchGestures = new Map();
      const options = { setup: s, approver: APPROVER, ask: async () => "todas", say: () => undefined, gestures };
      // The person approved the four-line list...
      const shown = await runBatch(batch, { engine: s.engine, onExecution: async (e) => e, onBatch: (b) => presentBatch(b, options) });
      expect(shown.gesture?.vetoed).toEqual([]);
      // ...and a line arrives claiming the same ref but a list of three with another hash.
      const edited = await s.engine.draft({
        items: [{ payee: batch.lines[0]!.alias, amount: batch.lines[0]!.amount_minor }],
        batch: { ref: batch.ref, batch_hash: "sha256:" + "0".repeat(64), index: 0, count: 3 },
      });
      if (!edited.ok) throw new Error(edited.reason);
      const decided = await handleExecution(edited.execution, options);
      expect(decided.state).toBe("denied");
      expect(decided.detail).toContain("the list changed after the gesture");
      expect(s.bundle.readApprovals().filter((a) => a.execution_id === edited.execution.id)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("an edited list after the gesture is refused before anything is drafted, and nobody is asked again", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "supplier-gesture-d-"));
    const four = fourLines();
    const first = open(stateDir);
    try {
      const report = await runBatch(four, gestureChannel(first, ["todas exceto 4"]).ctx);
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "settled", "settled", "refused"]);
    } finally {
      first.close();
    }

    // The fourth line's amount moves after the person approved the list.
    const edited: Batch = { ...four, lines: four.lines.map((l, i) => (i === 3 ? { ...l, amount_minor: l.amount_minor + 100 } : l)) };
    const second = open(stateDir);
    try {
      const channel = gestureChannel(second, []);
      const report = await runBatch(edited, channel.ctx);
      expect(channel.asked).toEqual([]);
      expect(report.refused?.reason).toBe("batch_set_changed");
      expect(report.gesture).toBeUndefined();
      expect(second.engine.list()).toHaveLength(4);
    } finally {
      second.close();
    }
  });

  it("without the hook nothing changes: each line is its own question, as the one-shot and the scenarios expect", async () => {
    const s = open(mkdtempSync(join(tmpdir(), "supplier-gesture-e-")));
    try {
      const batch = fourLines();
      const asked: string[] = [];
      const options = { setup: s, approver: APPROVER, ask: async (q: string) => (asked.push(q), "s"), say: () => undefined };
      const report = await runBatch(batch, { engine: s.engine, onExecution: (e) => handleExecution(e, options) });
      expect(asked).toHaveLength(4);
      expect(report.gesture).toBeUndefined();
      expect(report.lines.map((l) => l.dispatch)).toEqual(["settled", "settled", "settled", "settled"]);
    } finally {
      s.close();
    }
  });
});
