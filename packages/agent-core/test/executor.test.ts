/**
 * ent#1983: who executed a Test payment, as the API recorded it
 * (`payment.executor`), travels from the rail's answer onto the execution's
 * outcome; and the refusal of a Test mandate signed without an executor
 * (`funding_source_executor_required`) closes the execution failed, in the
 * API's own words, with nothing sent. The refusal goes through the real SDK
 * client against a local server, as `rail-errors.test.ts` does.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiClient } from "@codespar/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CodeSparRail } from "../src/api/rail.js";
import { createCodeSparClient } from "../src/api/client.js";
import { railErrorOf } from "../src/engine.js";
import { confirmsExecutor, EXECUTOR_LABELS, executorLabel, executorOf, executorProvider, isExecutorRefusal, publicExecutor, RECORDED_EXECUTOR, withNoRealMoney } from "../src/executor.js";
import type { PaymentRail, RailPayment } from "../src/rail.js";
import { CORE_STRINGS } from "../src/strings.js";
import { ESCOLA, harness } from "./helpers.js";

const approver = { id: "usr_demo", channel: "terminal" };

function payment(): RailPayment {
  return {
    attempt_id: "att_exec_0",
    mandate_id: "mdt_test_0001",
    amount_minor: 185000,
    currency: "BRL",
    payee: ESCOLA,
    purpose: "contas do mes",
    agent_id: "bills-agent",
    quote: { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, at: "2026-09-23T18:00:00.000Z" },
    approval: { items_hash: `sha256:${"1".repeat(64)}` },
    actor: { type: "agent", agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo" },
  };
}

function railAnswering(paymentBody: Record<string, unknown>): CodeSparRail {
  const post = vi.fn(async () => ({ payment: { transactionId: "tx_1", moneyMoved: false, ...paymentBody }, receipt: { id: "rcpt_1" } }));
  return new CodeSparRail({ post, get: vi.fn() } as unknown as ApiClient, { canonical: { any: "envelope" } as never, signature: "a".repeat(64) });
}

describe("payment.executor on the rail's answer", () => {
  it("is carried on a settled outcome when the API names it", async () => {
    expect(await railAnswering({ executor: "codespar_simulator" }).pay(payment())).toMatchObject({ status: "settled", executor: "codespar_simulator" });
    expect(await railAnswering({ executor: "provider_sandbox" }).pay(payment())).toMatchObject({ status: "settled", executor: "provider_sandbox" });
    // An answer recorded before ent#1983's public rename is carried as it came.
    expect(await railAnswering({ executor: "celcoin_sandbox" }).pay(payment())).toMatchObject({ status: "settled", executor: "celcoin_sandbox" });
  });

  it("is absent when the API names none: null (Live), missing (an API before ent#1983), or not a string", async () => {
    for (const body of [{ executor: null }, {}, { executor: 7 }, { executor: "" }]) {
      const out = await railAnswering(body).pay(payment());
      expect(out.status).toBe("settled");
      expect(out).not.toHaveProperty("executor");
    }
  });
});

describe("the engine keeps it on the execution", () => {
  it("a settled outcome records the executor the rail answered, and executorOf reads it", async () => {
    const h = harness({
      mode: "human",
      wrapRail: (inner): PaymentRail => ({
        name: inner.name,
        pay: async (p) => {
          const out = await inner.pay(p);
          return out.status === "settled" ? { ...out, executor: "codespar_simulator" } : out;
        },
        lookup: (id, p) => inner.lookup(id, p),
        receipt: (id, a) => inner.receipt(id, a),
      }),
    });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    expect(out.state).toBe("settled");
    expect(out.outcomes[0]).toMatchObject({ status: "settled", executor: "codespar_simulator" });
    expect(executorOf(out)).toBe("codespar_simulator");
  });

  it("the stub rail names none, and nothing is invented", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    expect(out.state).toBe("settled");
    expect(out.outcomes[0]).not.toHaveProperty("executor");
    expect(executorOf(out)).toBeNull();
  });
});

describe("labels", () => {
  it("are the API's words for each executor, by either name, each saying \"sem dinheiro real\" (Test only)", () => {
    expect(executorLabel("codespar_simulator")).toBe("Simulado pela CodeSpar · sem dinheiro real");
    expect(executorLabel("provider_sandbox")).toBe("Sandbox do provedor · sem dinheiro real");
    expect(executorLabel("celcoin_sandbox")).toBe("Integrado (sandbox Celcoin) · sem dinheiro real");
    expect(executorLabel("someone_else")).toBe("someone_else");
    expect(withNoRealMoney("Integrado (sandbox Celcoin) · sem dinheiro real")).toBe("Integrado (sandbox Celcoin) · sem dinheiro real");
    expect(RECORDED_EXECUTOR).toEqual({ codespar_simulator: "codespar_simulator", provider_sandbox: "celcoin_sandbox" });
    expect(Object.keys(EXECUTOR_LABELS).sort()).toEqual(["celcoin_sandbox", "codespar_simulator", "provider_sandbox"]);
  });

  it("ent#1983: a choice is confirmed by its public name or the one before the rename, never by another executor", () => {
    expect(confirmsExecutor("provider_sandbox", "provider_sandbox")).toBe(true);
    expect(confirmsExecutor("provider_sandbox", "celcoin_sandbox")).toBe(true);
    expect(confirmsExecutor("provider_sandbox", "codespar_simulator")).toBe(false);
    expect(confirmsExecutor("codespar_simulator", "codespar_simulator")).toBe(true);
    expect(confirmsExecutor("codespar_simulator", "provider_sandbox")).toBe(false);
    expect(confirmsExecutor("codespar_simulator", null)).toBe(false);
    expect(publicExecutor("celcoin_sandbox")).toBe("provider_sandbox");
    expect(publicExecutor("mercadopago")).toBeNull();
    expect(executorProvider({ executor: "provider_sandbox", executor_provider: "celcoin" })).toBe("celcoin");
    expect(executorProvider({ executor: "celcoin_sandbox" })).toBe("celcoin");
    expect(executorProvider({ executor: "provider_sandbox" })).toBeNull();
    expect(executorProvider({ executor: "codespar_simulator", executor_provider: null })).toBeNull();
  });

  it("every executor refusal has a line in both locales", () => {
    for (const code of ["funding_source_executor_required", "simulation_refused_live", "executor_test_only", "provider_sandbox_not_ready", "executor_provider_not_selectable"]) {
      expect(isExecutorRefusal(code)).toBe(true);
      expect(CORE_STRINGS["pt-BR"].executorHint(code)).toBeTruthy();
      expect(CORE_STRINGS.en.executorHint(code)).toBeTruthy();
    }
    expect(isExecutorRefusal("insufficient_funds")).toBe(false);
    expect(isExecutorRefusal(null)).toBe(false);
    expect(CORE_STRINGS["pt-BR"].executorHint("funding_source_executor_required")).toMatch(/npm run consent -- --yes/);
    expect(CORE_STRINGS.en.executorHint("insufficient_funds")).toMatch(/chosen at the consent/);
  });
});

describe("funding_source_executor_required, through the real client", () => {
  const REFUSAL = {
    status: 409,
    body: {
      error: {
        code: "funding_source_executor_required",
        message: "this mandate's funding source was signed without an executor, and a Test `pix-consent` source no longer falls back to a provider or to an unlabelled mock. Nothing was sent and the mandate, its history and its attempts are unchanged.",
        details: { next: { action: "reconsent_with_executor", endpoint: "POST /v1/consents", executor_choices: ["codespar_simulator", "provider_sandbox"] } },
      },
      request_id: null,
    },
  };
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(REFUSAL.status, { "content-type": "application/json" });
      res.end(JSON.stringify(REFUSAL.body));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  });

  it("closes the execution failed, a refusal and not an unknown outcome, with the API's code and words", async () => {
    const h = harness({ mode: "human", wrapRail: () => new CodeSparRail(createCodeSparClient({ apiKey: "csk_test_unit_0000", baseUrl, timeoutMs: 5_000 })) });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    expect(out.state).toBe("failed");
    expect(out.reason).toBe("rail_failed");
    expect(railErrorOf(out)).toMatchObject({ outcome: "failed", code: "funding_source_executor_required", message: REFUSAL.body.error.message });
    expect(isExecutorRefusal(railErrorOf(out)?.code)).toBe(true);
    expect(executorOf(out)).toBeNull();
  });
});
