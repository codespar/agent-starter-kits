import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkScenario, listScenarios, loadScenario, runScenario } from "@codespar/agent-runtime";
import { ORDERS, checkOrder } from "../src/orders.js";
import { agent } from "../src/kit.js";

const runsDir = mkdtempSync(join(tmpdir(), "pix-payment-runs-"));
afterAll(() => rmSync(runsDir, { recursive: true, force: true }));
const DOCUMENTS = ORDERS.map((o) => o.document);

describe("section 12: scenario packs, on the replay provider and the stub rail", () => {
  const required = ["happy-path", "charge-expired", "prompt-injection"];

  it("ships the three packs the cookbook names", () => {
    expect(listScenarios(agent)).toEqual([...required].sort());
  });

  for (const name of required) {
    const scenario = loadScenario(agent, name);
    for (const mode of scenario.modes) {
      it(`${name} [${mode}] ends in the states the pack declares, with an actor on every event and no document in the clear`, async () => {
        const run = await runScenario(agent, scenario, { mode, runsDir });
        const check = checkScenario(scenario, run);
        expect(check.failures).toEqual([]);
        expect(check.ok).toBe(true);
        const events = readFileSync(join(run.bundle_dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { actor?: unknown });
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) expect(e.actor).toBeDefined();
        for (const file of readdirSync(join(run.bundle_dir, "receipts"))) {
          const receipt = JSON.parse(readFileSync(join(run.bundle_dir, "receipts", file), "utf8")) as { kind?: string; chain: string | null; payment: { payee: string | null; money_moved: boolean; sandbox: boolean } };
          expect(receipt.kind).toBe("charge");
          expect(receipt.chain).toBeNull();
          expect(receipt.payment.money_moved).toBe(false);
          expect(receipt.payment.sandbox).toBe(true);
          expect(receipt.payment.payee ?? "").toContain("***");
        }
        const snapshot = readFileSync(join(run.bundle_dir, "mandate.snapshot.json"), "utf8");
        for (const doc of DOCUMENTS) expect(snapshot).not.toContain(doc);
      });
    }
  }

  it("happy-path: one Pix of exactly the order's total, due today, presented once, told once", async () => {
    const run = await runScenario(agent, loadScenario(agent, "happy-path"), { mode: "human", runsDir });
    const approvals = JSON.parse(readFileSync(join(run.bundle_dir, "approval.json"), "utf8")) as Array<{ items: Array<{ amount_minor?: number; amount?: number; due_date?: string }> }>;
    expect(approvals[0]?.items[0]?.due_date).toBe("2026-09-23");
    const events = readFileSync(join(run.bundle_dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload?: { payable?: boolean } });
    expect(events.filter((e) => e.type === "charge.instrument" && e.payload?.payable === true)).toHaveLength(1);
    expect(events.filter((e) => e.type === "message.debtor")).toHaveLength(1);
    expect(run.charges_issued).toBe(1);
  });
});

describe("the order policy", () => {
  const order = ORDERS[0]!;
  it("accepts exactly the order's total, for one order", () => {
    expect(checkOrder({ items: [{ payee: order.document, amount: order.total_minor }] as never, total: order.total_minor })).toBeUndefined();
  });
  it("refuses another amount, two items, and a customer without an order, always as outside_envelope", () => {
    expect(checkOrder({ items: [{ payee: order.document, amount: 100 }] as never, total: 100 })?.reason).toBe("outside_envelope");
    expect(checkOrder({ items: [{ payee: order.document, amount: 900 }, { payee: order.document, amount: 900 }] as never, total: 1800 })?.reason).toBe("outside_envelope");
    expect(checkOrder({ items: [{ payee: "22233344405", amount: 1800 }] as never, total: 1800 })?.reason).toBe("outside_envelope");
    expect(checkOrder({ items: [{ payee: order.document, amount: 100 }] as never, total: 100 }, "en")?.detail).toMatch(/exactly the order's total/);
  });
});
