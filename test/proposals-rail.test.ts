/**
 * `--rail proposals`: the exported code of a Playground run on the integrated
 * Test drafts the same proposal in the same conversation, under the same
 * mandate, through `POST /v1/proposals` with the project's Test key, and reads
 * it back until the person pays it on the card.
 *
 * The API is a fake `fetch` here: what is checked is what the kit sends, that
 * it never signs a mandate, funds an account or pays, and what it makes of each
 * answer. The routes themselves are tested in codespar-enterprise
 * (key-proposals.integration.test.ts).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mandate } from "@codespar/agent-core";
import { createHostedRun } from "@codespar/agent-runtime";
import { loadAgent } from "../packages/agent-runtime/src/agent.js";
import { setup } from "../packages/agent-runtime/src/setup.js";
import { handleExecution } from "../packages/agent-runtime/src/terminal.js";
import { start } from "../packages/agent-runtime/src/commands/start.js";
import { ProposalPaymentRail } from "../packages/agent-runtime/src/hosted/proposals.js";
import { decodePlaygroundContext, encodePlaygroundContext, httpProposalRail, playgroundMandate, type PlaygroundContext } from "../packages/agent-runtime/src/proposals-api.js";
import { FakeProposals, hostedKit, ports, ScriptedRuntime } from "../packages/agent-runtime/test/hosted-ports.js";

const ROOT = resolve(import.meta.dirname, "..");
const BILLS = join(ROOT, "agents/bills-agent");
const KEY = "csk_test_fake_key_for_the_proposals_rail"; // gitleaks:allow (not a key: the fake fetch reads no credential)
const PAYEE_KEY = "0b5d6c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "proposals-rail-"));
  tempDirs.push(dir);
  return dir;
};

const CONTEXT: PlaygroundContext = {
  v: 1,
  conversation_id: "cnv_playground_1",
  mandate: {
    id: "cm_HICRUYzxiZZiX6Hc",
    purpose: "Playground: recebedores de teste da plataforma",
    cap_minor: 20_000,
    per_tx_cap_minor: 3_000,
    periodic_cap: { window: "month", cap_minor: 10_000 },
    expires_at: "2027-11-07T00:00:00.000Z",
    beneficiaries: [{ alias: "conta-teste", name: "Recebedor de teste da plataforma" }],
  },
};

/** A fake API: every request recorded, each proposal moving through the states the test scripts. */
function fakeApi(script: { submit?: (body: Record<string, unknown>) => { status: number; body: unknown }; reads?: Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null; auth: string | null }> = [];
  let reads = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? "GET", url: String(url), body, auth: (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? null });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (String(url).endsWith("/v1/proposals") && init?.method === "POST") {
      const answer = script.submit?.(body!) ?? { status: 201, body: { proposal: { id: "prp_dabcdefabcdefabc", state: "drafted" }, next_action: { kind: "person_payment" }, idempotent_replay: false } };
      return json(answer.status, answer.body);
    }
    if (String(url).includes("/v1/proposals/")) {
      const read = script.reads?.[Math.min(reads, (script.reads?.length ?? 1) - 1)] ?? { state: "succeeded", receipt_id: "rcpt_platform_1", failure: null };
      reads += 1;
      return json(200, { proposal: { id: "prp_dabcdefabcdefabc", ...read }, next_action: null });
    }
    return json(404, { error: { code: "not_found", message: "no such route in the fake" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("the context the export carries", () => {
  it("round-trips through one shell word, and refuses anything else by naming the flag", () => {
    const word = encodePlaygroundContext(CONTEXT);
    expect(word).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePlaygroundContext(word)).toEqual(CONTEXT);
    expect(() => decodePlaygroundContext("not-a-context")).toThrow(/--playground/);
    expect(() => decodePlaygroundContext(encodePlaygroundContext({ ...CONTEXT, conversation_id: "" } as PlaygroundContext))).toThrow(/--playground/);
  });

  it("becomes the kit's policy: the run's mandate, its receivers by alias (no key)", () => {
    const m = playgroundMandate(CONTEXT);
    expect(m).toMatchObject({ id: CONTEXT.mandate.id, cap_minor: 20_000, per_tx_cap_minor: 3_000, periodic_cap: { window: "month", cap_minor: 10_000 }, merchant_allowlist: ["conta-teste"], beneficiaries: [{ alias: "conta-teste", payee: "conta-teste" }], status: "active" });
  });

  it("is what a hosted codespar-test run exports: its conversation and its mandate, without the receivers' keys", async () => {
    const mandate: Mandate = {
      id: "cm_HICRUYzxiZZiX6Hc",
      version: 1,
      consumer_id: "cst_playground",
      agent_id: "bills-agent",
      purpose: "Playground: recebedores de teste da plataforma",
      currency: "BRL",
      cap_minor: 20_000,
      per_tx_cap_minor: 3_000,
      periodic_cap: { window: "month", cap_minor: 10_000 },
      merchant_pin_kind: "pix-key",
      merchant_allowlist: [PAYEE_KEY],
      beneficiaries: [{ alias: "conta-teste", name: "Recebedor de teste da plataforma", payee: PAYEE_KEY }],
      status: "active",
      expires_at: "2027-11-07T00:00:00.000Z",
      source: "consent",
    };
    const model = new ScriptedRuntime([{ text: "ok" }]);
    const run = await createHostedRun(
      await hostedKit(BILLS, ROOT),
      ports({ rail: { executor: "codespar-test", proposals: new FakeProposals(), mandate, conversationId: "cnv_playground_1" }, model: { mode: "model", runtime: model, model: "claude-opus-4-7" } }),
      { commandId: "c", modelMode: "model", executor: "codespar-test", options: { exampleId: "conta-teste" } },
    );
    const { code } = await run.export();
    const start = code.commands[code.commands.length - 1]!;
    expect(start).toMatch(/ -- --rail proposals --playground [A-Za-z0-9_-]+ --provider anthropic /);
    const ctx = decodePlaygroundContext(start.split("--playground ")[1]!.split(" ")[0]!);
    expect(ctx).toMatchObject({ conversation_id: "cnv_playground_1", mandate: { id: "cm_HICRUYzxiZZiX6Hc", beneficiaries: [{ alias: "conta-teste" }] } });
    expect(code.commands.join("\n")).not.toContain(PAYEE_KEY);
  });
});

describe("the HTTP rail", () => {
  it("drafts one proposal per attempt, with the run's mandate and conversation, the receiver's alias and a key per attempt", async () => {
    const { fetchFn, calls } = fakeApi();
    const rail = httpProposalRail({ apiKey: KEY, baseUrl: "https://api.test.example", mandateId: CONTEXT.mandate.id, conversationId: CONTEXT.conversation_id, fetch: fetchFn });
    const req = { executionId: "exe_1", attemptId: "att_abc_0", items: [{ payee: "conta-teste", beneficiary: "Recebedor de teste da plataforma", amountMinor: 1000, description: "conta de teste", dueDate: null }], totalMinor: 1000, currency: "BRL", itemsHash: null, batchHash: null };
    expect(await rail.submit(req)).toEqual({ proposalId: "prp_dabcdefabcdefabc", state: "drafted" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.test.example/v1/proposals",
      auth: `Bearer ${KEY}`,
      body: { mandate_id: CONTEXT.mandate.id, conversation_id: CONTEXT.conversation_id, payee: "conta-teste", amount_minor: 1000, currency: "BRL", description: "conta de teste", idempotency_key: "kit:att_abc_0" },
    });
    expect(await rail.read("prp_dabcdefabcdefabc")).toEqual({ state: "succeeded", receiptId: "rcpt_platform_1", failureCode: null });
  });

  it("a refusal the platform explains fails the attempt with its code; a running turn is unknown, never a failure", async () => {
    const store = { listOutbox: () => [{ execution_id: "exe_1", payload: { attempts: ["att_abc_0"] } }] } as never;
    const payment = { attempt_id: "att_abc_0", payee: "conta-teste", amount_minor: 1000, currency: "BRL" } as never;
    const refused = fakeApi({ submit: () => ({ status: 409, body: { error: { code: "proposal_mandate_not_in_force", message: "Mandate cm_x is not in force" } } }) });
    const r1 = new ProposalPaymentRail(httpProposalRail({ apiKey: KEY, mandateId: "cm_x", conversationId: "cnv_1", fetch: refused.fetchFn }), store);
    expect(await r1.pay(payment)).toMatchObject({ status: "failed", code: "proposal_mandate_not_in_force" });
    const busy = fakeApi({ submit: () => ({ status: 409, body: { error: { code: "proposal_turn_running", message: "a turn is running" } } }) });
    const r2 = new ProposalPaymentRail(httpProposalRail({ apiKey: KEY, mandateId: "cm_x", conversationId: "cnv_1", fetch: busy.fetchFn }), store);
    expect(await r2.pay(payment)).toMatchObject({ status: "uncertain", code: "proposal_submit_unknown" });
  });
});

describe("a terminal run on --rail proposals", () => {
  it("forwards the payment, drafts the proposal, waits for the person and ends with the platform's receipt; no consent, no funding, no payment call", async () => {
    const { fetchFn, calls } = fakeApi({ reads: [{ state: "drafted", receipt_id: null, failure: null }, { state: "succeeded", receipt_id: "rcpt_platform_1", failure: null }] });
    vi.stubGlobal("fetch", fetchFn);
    try {
      const state = scratch();
      const agent = await loadAgent(BILLS);
      const lines: string[] = [];
      const s = setup(agent, { rail: "proposals", playground: CONTEXT, stateDir: state, runsDir: join(state, "runs"), env: { CODESPAR_API_KEY: KEY }, mode: "human", locale: "pt-BR", say: (l) => lines.push(l) });
      expect(s.mandate.id).toBe(CONTEXT.mandate.id);
      // Later commands (resume, reconcile) find the same rail in this state dir.
      expect(JSON.parse(readFileSync(join(state, "playground.json"), "utf8"))).toEqual(CONTEXT);
      const draft = await s.engine.draft({ items: [{ payee: "conta-teste", amount: 1000 }] });
      if (!draft.ok) throw new Error("draft refused");
      const done = await handleExecution(draft.execution, { setup: s, approver: { id: "usr_terminal", channel: "terminal" }, decision: "none", waitSeconds: 30, say: (l) => lines.push(l) });
      expect(done.state).toBe("settled");
      expect(done.outcomes[0]).toMatchObject({ transaction_id: "prp_dabcdefabcdefabc", receipt_id: "rcpt_platform_1" });
      expect(done.history.some((h) => h.to === "approved" && h.actor.channel === "platform-proposal")).toBe(true);
      expect(lines.join("\n")).toContain("proposta prp_dabcdefabcdefabc criada na conversa do Playground");
      // Only the proposals routes were called: no consent, no /v1/test/fund, no payment.
      expect(calls.every((c) => /\/v1\/proposals(\/|$)/.test(c.url))).toBe(true);
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
      s.close();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 60_000);
});

describe("a proposal still waiting when the terminal stops waiting", () => {
  it("is read back by `npm run resume` on the same rail, from the state dir, and never drafted again", async () => {
    let paid = false;
    const { fetchFn, calls } = fakeApi();
    const reads: Array<Record<string, unknown>> = [];
    const routed = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/v1/proposals/")) {
        reads.push({ at: Date.now() });
        const state = paid ? { state: "succeeded", receipt_id: "rcpt_platform_2", failure: null } : { state: "drafted", receipt_id: null, failure: null };
        return new Response(JSON.stringify({ proposal: { id: "prp_dabcdefabcdefabc", ...state }, next_action: null }), { status: 200 });
      }
      return fetchFn(url, init);
    }) as typeof fetch;
    vi.stubGlobal("fetch", routed);
    const state = scratch();
    vi.stubEnv("BILLS_STATE_DIR", state);
    vi.stubEnv("BILLS_RUNS_DIR", join(state, "runs"));
    vi.stubEnv("CODESPAR_API_KEY", KEY);
    try {
      const agent = await loadAgent(BILLS);
      const s = setup(agent, { rail: "proposals", playground: CONTEXT, mode: "human", locale: "en", say: () => undefined });
      const draft = await s.engine.draft({ items: [{ payee: "conta-teste", amount: 1000 }] });
      if (!draft.ok) throw new Error("draft refused");
      const left = await handleExecution(draft.execution, { setup: s, approver: { id: "usr_terminal", channel: "terminal" }, decision: "none", waitSeconds: 0, say: () => undefined });
      expect(left.state).toBe("executing");
      s.close();

      paid = true;
      const { resume } = await import("../packages/agent-runtime/src/commands/resume.js");
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await resume(agent, []);
      const again = setup(agent, { mode: "human", locale: "en", say: () => undefined });
      expect(again.railKind).toBe("proposals");
      expect(again.engine.get(left.id)).toMatchObject({ state: "settled" });
      again.close();
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }, 60_000);
});

describe("npm start --rail proposals stops before anything when something is missing", () => {
  let written: string[];
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("CODESPAR_API_KEY", "");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("names the test key when there is none", async () => {
    const code = await start(await loadAgent(BILLS), ["--rail", "proposals", "--playground", encodePlaygroundContext(CONTEXT), "--locale", "en"]);
    expect(code).toBe(1);
    expect(written.join("")).toContain("CODESPAR_API_KEY");
  });

  it("names --playground when the context is missing", async () => {
    vi.stubEnv("CODESPAR_API_KEY", KEY);
    const code = await start(await loadAgent(BILLS), ["--rail", "proposals", "--locale", "en"]);
    expect(code).toBe(1);
    expect(written.join("")).toContain("--rail proposals needs --playground");
  });

  it("refuses a context the export did not write", async () => {
    vi.stubEnv("CODESPAR_API_KEY", KEY);
    const code = await start(await loadAgent(BILLS), ["--rail", "proposals", "--playground", "garbage", "--locale", "en"]);
    expect(code).toBe(2);
    expect(written.join("")).toContain("--playground");
  });
});

