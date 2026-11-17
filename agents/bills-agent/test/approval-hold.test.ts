import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fixedClock, StubRail, type Execution, type ToolContext } from "@codespar/agent-core";
import { handleExecution, setup, type Setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { codesparPay, listBills } from "../src/modules/pix-out.js";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function open(runsDir: string, stateDir: string, transcript?: string, locale: "pt-BR" | "en" = "pt-BR", uncertainPayees: string[] = []): Setup {
  return setup(agent, {
    mode: "human",
    rail: "stub",
    ...(transcript ? { provider: "replay" as const, transcript } : {}),
    runsDir,
    stateDir,
    now: fixedClock("2026-11-12T14:00:00-03:00"),
    say: () => undefined,
    locale,
    stubRail: { approvalPayees: ["financeiro@escola-aurora.example.com.br"], uncertainPayees },
  });
}

/** The agent's own CLI on a temp state and runs directory, with no key in reach: nothing here may leave the machine. */
function cli(command: "reconcile" | "resume", stateDir: string, runsDir: string) {
  return spawnSync(process.execPath, [resolve(import.meta.dirname, "../../../packages/agent-runtime/bin.mjs"), command, "--json"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runsDir, ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", CODESPAR_API_KEY: "" },
    encoding: "utf8",
  });
}

function context(s: Setup): ToolContext {
  return {
    engine: s.engine,
    onExecution: async (execution: Execution) => {
      let current = execution;
      if (current.state === "awaiting_approval") current = s.engine.approve(current.id, { id: "usr_demo", channel: "terminal" });
      if (current.state === "approved") current = await s.engine.execute(current.id);
      return current;
    },
  };
}

describe("a provider approval hold", () => {
  it("resumes an approved provider hold with one receipt and marks the bill paid", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const transcript = resolve(import.meta.dirname, "../scenarios/happy-path.transcript.jsonl");
    const initial = open(runsDir, stateDir, transcript);
    try {
      const lines: string[] = [];
      const loop = initial.makeLoop(initial.makeRuntime(), (execution) => handleExecution(execution, {
        setup: initial,
        approver: { id: "usr_demo", channel: "terminal" },
        decision: "approve",
        say: (line) => lines.push(line),
      }));
      await loop.turn("pague a escola de outubro");
      expect(lines.join("\n")).toContain("o pagamento aguarda aprovação de uma pessoa (apr_stub_");
      expect(lines.join("\n")).not.toMatch(/falhou|failed/i);
    } finally {
      initial.close();
    }

    const pending = cli("resume", stateDir, runsDir);
    expect(pending.status).toBe(3);
    expect(JSON.parse(pending.stdout)).toMatchObject({ resumed: [{ state: "executing" }] });
    const pendingReconcile = cli("reconcile", stateDir, runsDir);
    expect(pendingReconcile.status).toBe(0);
    expect(JSON.parse(pendingReconcile.stdout)).toMatchObject({ findings: [expect.objectContaining({ kind: "awaiting_approval" })] });
    const awaiting = open(runsDir, stateDir);
    try {
      const attempt = awaiting.engine.list({ state: "executing" })[0]!.rail_approvals![0]!.attempt_id;
      new StubRail(awaiting.store).setApprovalDecision(attempt, "approved");
    } finally {
      awaiting.close();
    }
    const resumed = cli("resume", stateDir, runsDir);
    expect(resumed.status).toBe(0);
    const payload = JSON.parse(resumed.stdout) as { resumed: Array<{ state: string; receipt_ids: string[] }>; bundle_dir: string };
    expect(payload.resumed).toMatchObject([{ state: "settled", receipt_ids: [expect.stringMatching(/^rcpt_stub_/)] }]);
    const receiptId = payload.resumed[0]!.receipt_ids[0]!;
    expect(existsSync(join(payload.bundle_dir, "receipts", `${receiptId}.json`))).toBe(true);
    expect(readdirSync(runsDir, { recursive: true }).filter((path) => String(path).endsWith(`${receiptId}.json`))).toHaveLength(1);
    const reconciled = cli("reconcile", stateDir, runsDir);
    expect(reconciled.status).toBe(0);
    expect(JSON.parse(reconciled.stdout)).toMatchObject({ findings: [] });
    const settled = open(runsDir, stateDir, transcript);
    try {
      expect(await listBills(settled.config)({}, context(settled))).toMatchObject({ bills: expect.arrayContaining([expect.objectContaining({ alias: "escola", paid_this_window: true })]) });
    } finally {
      settled.close();
    }
  });

  it("reports the provider approval hold in English", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const transcript = resolve(import.meta.dirname, "../scenarios/happy-path.transcript.jsonl");
    const initial = open(runsDir, stateDir, transcript, "en");
    try {
      const lines: string[] = [];
      const loop = initial.makeLoop(initial.makeRuntime(), (execution) => handleExecution(execution, {
        setup: initial,
        approver: { id: "usr_demo", channel: "terminal" },
        decision: "approve",
        say: (line) => lines.push(line),
      }));
      await loop.turn("pague a escola de outubro");
      expect(lines.join("\n")).toContain("payment awaits a person's approval (apr_stub_");
      expect(lines.join("\n")).not.toMatch(/failed|falhou/i);
    } finally {
      initial.close();
    }
  });

  it("closes a denied provider approval hold without dispatching again", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const initial = open(runsDir, stateDir);
    try {
      await codesparPay({ action: "pix", items: [{ payee: "escola", amount_minor: 185000 }] }, context(initial));
      const attempt = initial.engine.list({ state: "executing" })[0]!.rail_approvals![0]!.attempt_id;
      new StubRail(initial.store).setApprovalDecision(attempt, "denied");
    } finally {
      initial.close();
    }
    const resumed = cli("resume", stateDir, runsDir);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ resumed: [{ state: "failed", rail_error: { code: "psp_attempt_conflict" } }] });
    const reconciled = cli("reconcile", stateDir, runsDir);
    expect(reconciled.status).toBe(0);
    const closed = open(runsDir, stateDir);
    try {
      expect(closed.store.listEvents().filter((event) => event.type === "rail.dispatch")).toHaveLength(1);
    } finally {
      closed.close();
    }
  });

  it("tells the person which provider approval a repeated request is waiting on, without a new rail presentation", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const transcript = resolve(import.meta.dirname, "../scenarios/happy-path.transcript.jsonl");
    const turn = async (s: Setup) => {
      const lines: string[] = [];
      const loop = s.makeLoop(s.makeRuntime(), (execution) => handleExecution(execution, { setup: s, approver: { id: "usr_demo", channel: "terminal" }, decision: "approve", say: (line) => lines.push(line) }));
      return { result: await loop.turn("pague a escola de outubro"), said: lines.join("\n") };
    };
    const first = open(runsDir, stateDir, transcript);
    try {
      const { result } = await turn(first);
      // The run left its own execution on the rail: what `outcomeExitCode` turns into exit 3 (agent-runtime's outcome.test.ts).
      expect(result.executions).toMatchObject([{ state: "executing", reason: "rail_awaiting_approval" }]);
    } finally {
      first.close();
    }

    for (const [locale, sentence] of [["pt-BR", "o pagamento aguarda aprovação de uma pessoa"], ["en", "payment awaits a person's approval"]] as const) {
      const again = open(runsDir, stateDir, transcript, locale);
      try {
        const { result, said } = await turn(again);
        const held = again.engine.list({ state: "executing" })[0]!;
        const approval = held.rail_approvals![0]!.approval_id;
        expect(said).toContain(`${sentence} (${approval})`);
        expect(said).toContain(held.id);
        expect(said).not.toMatch(/falhou|failed/i);
        expect(result.not_run).toEqual([{ ref: "escola", why: "in_progress", detail: expect.stringContaining(held.id) }]);
        // The refused repeat and the line naming the hold: what agent-runtime's outcome.test.ts counts as one open line, exit 0.
        expect(result.executions).toMatchObject([{ state: "denied", reason: "duplicate_awaiting_approval" }]);
        expect(again.engine.list({ state: "executing" })).toHaveLength(1);
        expect(again.store.listEvents().filter((event) => event.type === "rail.dispatch")).toHaveLength(1);
      } finally {
        again.close();
      }
    }
  });

  it("keeps an identical request on its original attempt, while a different amount dispatches", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const request = { action: "pix", items: [{ payee: "escola", amount_minor: 185000 }] };
    const first = open(runsDir, stateDir);
    try {
      expect(await codesparPay(request, context(first))).toMatchObject({ status: "executing", reason: "rail_awaiting_approval" });
    } finally {
      first.close();
    }

    const again = open(runsDir, stateDir);
    try {
      expect(await codesparPay(request, context(again))).toMatchObject({ status: "in_progress", execution_id: expect.any(String), approval_ids: [expect.any(String)] });
      expect(await codesparPay({ action: "pix", items: [{ payee: "escola", amount_minor: 185001 }] }, context(again))).toMatchObject({ status: "executing", reason: "rail_awaiting_approval" });
      expect(again.store.listEvents().filter((event) => event.type === "rail.dispatch")).toHaveLength(2);
    } finally {
      again.close();
    }
  });

  it("keeps a request on its hold when a sibling attempt is unknown", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const request = { action: "pix", items: [{ payee: "escola", amount_minor: 185000 }, { payee: "mercado", amount_minor: 10000 }] };
    const mercado = ["+5511999990001"];
    const first = open(runsDir, stateDir, undefined, "pt-BR", mercado);
    try {
      // The unknown sibling names the execution's reason; the hold is still on record.
      expect(await codesparPay(request, context(first))).toMatchObject({ status: "executing", reason: "rail_uncertain" });
      expect(first.engine.list({ state: "executing" })[0]!.rail_approvals).toHaveLength(1);
    } finally {
      first.close();
    }

    const again = open(runsDir, stateDir, undefined, "pt-BR", mercado);
    try {
      const held = again.engine.list({ state: "executing" })[0]!;
      expect(await codesparPay(request, context(again))).toMatchObject({ status: "in_progress", execution_id: held.id, approval_ids: [held.rail_approvals![0]!.approval_id] });
      expect(again.store.listEvents().filter((event) => event.type === "rail.dispatch")).toHaveLength(2);
    } finally {
      again.close();
    }
  });

  it("names the original hold when the repeat would also pass the window cap", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const request = { action: "pix", items: [{ payee: "escola", amount_minor: 200000 }, { payee: "escola", amount_minor: 150000 }] };
    const s = open(runsDir, stateDir);
    try {
      expect(await codesparPay(request, context(s))).toMatchObject({ status: "executing", reason: "rail_awaiting_approval" });
      const held = s.engine.list({ state: "executing" })[0]!;
      const notRun: Array<{ why: string; detail?: string }> = [];
      const repeat = await codesparPay(request, { ...context(s), onNotRun: (line) => notRun.push(line) });
      expect(repeat).toMatchObject({ status: "in_progress", execution_id: held.id, approval_ids: held.rail_approvals!.map((approval) => approval.approval_id) });
      // The cap's refusal is counted as itself; the line is said by the kit's description of it.
      expect(notRun).toEqual([]);
      const refused = s.engine.list({ state: "denied" })[0]!;
      expect(refused.reason).toBe("window_cap_exceeded");
      expect(agent.kit.describeExecution(refused, s).join("\n")).toContain(`o pagamento aguarda aprovação de uma pessoa (${held.rail_approvals!.map((approval) => approval.approval_id).join(", ")})`);
      expect(s.store.listEvents().filter((event) => event.type === "rail.dispatch")).toHaveLength(2);
    } finally {
      s.close();
    }
  });

  it("refuses at approval a request drafted before the same request was held", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const s = open(runsDir, stateDir);
    try {
      const early = await s.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
      if (!early.ok) throw new Error("draft refused");
      expect(early.execution.state).toBe("awaiting_approval");
      expect(await codesparPay({ action: "pix", items: [{ payee: "escola", amount_minor: 185000 }] }, context(s))).toMatchObject({ status: "executing", reason: "rail_awaiting_approval" });

      const late = await context(s).onExecution(early.execution);
      expect(late).toMatchObject({ state: "denied", reason: "duplicate_awaiting_approval" });
      expect(s.store.listEvents().filter((event) => event.type === "rail.dispatch")).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it("refuses at execution a request approved before the same request was held", async () => {
    const runsDir = tempDir(join(tmpdir(), "bills-hold-runs-"));
    const stateDir = tempDir(join(tmpdir(), "bills-hold-state-"));
    const s = open(runsDir, stateDir);
    try {
      const early = await s.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
      if (!early.ok) throw new Error("draft refused");
      const approved = s.engine.approve(early.execution.id, { id: "usr_demo", channel: "terminal" });
      expect(approved.state).toBe("approved");
      expect(await codesparPay({ action: "pix", items: [{ payee: "escola", amount_minor: 185000 }] }, context(s))).toMatchObject({ status: "executing", reason: "rail_awaiting_approval" });

      expect(await s.engine.execute(approved.id)).toMatchObject({ state: "denied", reason: "duplicate_awaiting_approval" });
      expect(s.store.listEvents().filter((event) => event.type === "rail.dispatch")).toHaveLength(1);
    } finally {
      s.close();
    }
  });
});
