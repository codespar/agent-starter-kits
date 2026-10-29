/**
 * Section 11: what the proof bundle has to carry for `npm run inspect` to
 * answer "why could the agent pay this" from the folder alone — the rail's
 * request and its answer per attempt, and a receipt path that travels with
 * the bundle instead of naming the machine that wrote it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maskPayee } from "../src/bundle.js";
import { ESCOLA, harness, MERCADO } from "./helpers.js";

const approver = { id: "usr_demo", channel: "terminal" };

async function settledRun() {
  const h = harness({ mode: "human" });
  const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 185000, description: "outubro" }] });
  if (!draft.ok) throw new Error("refused");
  const approved = h.engine.approve(draft.execution.id, approver);
  const settled = await h.engine.execute(approved.id);
  return { h, settled };
}

describe("the proof bundle records the rail call and its answer", () => {
  it("rail.dispatch names the idempotency key that makes a retry the same payment", async () => {
    const { h, settled } = await settledRun();
    const dispatch = h.bundle.readEvents().find((e) => e["type"] === "rail.dispatch");
    expect(dispatch).toBeDefined();
    const payload = dispatch!["payload"] as Record<string, unknown>;
    expect(payload["idempotency_key"]).toBe(settled.idempotency_key);
    expect(payload["attempt_id"]).toBe(settled.outcomes[0]?.attempt_id);
    expect(payload["rail"]).toBe("stub");
  });

  it("rail.outcome carries what the rail answered: transaction, receipt and whether money moved", async () => {
    const { h, settled } = await settledRun();
    const outcome = h.bundle.readEvents().find((e) => e["type"] === "rail.outcome");
    const payload = outcome!["payload"] as Record<string, unknown>;
    expect(payload["status"]).toBe("settled");
    expect(payload["receipt_id"]).toBe(settled.outcomes[0]?.receipt_id);
    expect(payload["transaction_id"]).toBe(settled.outcomes[0]?.transaction_id);
    expect(payload["money_moved"]).toBe(false);
    expect(payload["sandbox"]).toBe(true);
    // Never the provider's echo: `raw` may carry payer data the bundle does not promise to mask.
    expect(payload["raw"]).toBeUndefined();
  });

  it("a refused attempt records the rail's own code and message", async () => {
    const h = harness({ mode: "human", rail: { refusePayees: ["escola@exemplo.com.br"] } });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!draft.ok) throw new Error("refused");
    const approved = h.engine.approve(draft.execution.id, approver);
    await h.engine.execute(approved.id);
    const outcome = h.bundle.readEvents().find((e) => e["type"] === "rail.outcome");
    const payload = outcome!["payload"] as Record<string, unknown>;
    expect(payload["status"]).toBe("failed");
    expect(payload["code"]).toBeTypeOf("string");
    expect(payload["message"]).toBeTypeOf("string");
  });

  it("receipt.saved names the file inside the bundle, not the machine that wrote it", async () => {
    const { h } = await settledRun();
    const saved = h.bundle.readEvents().find((e) => e["type"] === "receipt.saved");
    const path = (saved!["payload"] as { path: string }).path;
    expect(path).toMatch(/^receipts\//);
    expect(path).not.toContain(h.bundle.dir);
    const receipt = JSON.parse(readFileSync(join(h.bundle.dir, path), "utf8")) as { payment: { payee: string } };
    expect(receipt.payment.payee).toBe(maskPayee("escola@exemplo.com.br"));
  });

  it("the mandate snapshot carries the version the approval artifact names", async () => {
    const { h, settled } = await settledRun();
    h.bundle.mandateSnapshot(h.engine.mandate);
    const snapshot = JSON.parse(readFileSync(join(h.bundle.dir, "mandate.snapshot.json"), "utf8")) as { version: number; signature?: string };
    expect(snapshot.version).toBe(settled.mandate.version);
    expect(snapshot.signature).toBeUndefined();
    expect(h.bundle.readApprovals()[0]?.mandate.version).toBe(snapshot.version);
  });

  it("maskPayee is idempotent, so a reader may apply it to a value the bundle already masked", () => {
    for (const raw of ["escola@exemplo.com.br", "+5511999990001", "12345678909", "*"]) {
      expect(maskPayee(maskPayee(raw))).toBe(maskPayee(raw));
    }
  });
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("the proof bundle holds no full payee key (#116)", () => {
  it("no file of a run that escalated, settled and was refused names a mandate payee in the clear", async () => {
    // In mandate mode the first payment to mercado escalates with a detail that names its key, and the rail's refusal of escola names escola's.
    const h = harness({ mode: "mandate", rail: { refusePayees: [ESCOLA] } });
    h.bundle.mandateSnapshot(h.engine.mandate);
    const big = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    const small = await h.engine.draft({ items: [{ payee: "mercado", amount: 1000 }] });
    if (!big.ok || !small.ok) throw new Error("refused");
    await h.engine.execute(h.engine.approve(big.execution.id, approver).id);
    await h.engine.execute(h.engine.approve(small.execution.id, approver).id);

    const payees = [...h.engine.mandate.beneficiaries.map((b) => b.payee), ...h.engine.mandate.merchant_allowlist].filter((p) => p !== "*");
    // The free text is there, with the key masked inside it.
    const log = readFileSync(join(h.bundle.dir, "events.jsonl"), "utf8");
    expect(log).toContain(`(${maskPayee(MERCADO)}) under this mandate`);
    expect(log).toContain(`refused payee ${maskPayee(ESCOLA)}`);
    const files = filesUnder(h.bundle.dir);
    expect(files.map((f) => f.slice(h.bundle.dir.length + 1))).toEqual(expect.arrayContaining(["events.jsonl", "approval.json", "mandate.snapshot.json"]));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const payee of payees) expect(text.includes(payee), `${payee} in ${file}`).toBe(false);
    }
  });

  it("approval.json is the artifact with its payees masked, its hash and signature untouched, and the full one stays in state.db", async () => {
    const { h } = await settledRun();
    const [copy] = h.bundle.readApprovals();
    const full = h.store.getApproval(copy!.approval_id)!;
    expect(copy!.payee_masked).toBe(true);
    expect(copy!.items.map((i) => i.payee)).toEqual([maskPayee(ESCOLA)]);
    expect(copy!.items_hash).toBe(full.items_hash);
    expect(copy!.signature).toEqual(full.signature);
    expect(full.items.map((i) => i.payee)).toEqual([ESCOLA]);
    expect(full.payee_masked).toBeUndefined();
  });

  it("the stub rail refuses a payee scripted by its masked key, which is what rerun reads from a bundle", async () => {
    const h = harness({ mode: "human", rail: { refusePayees: [maskPayee(ESCOLA)] } });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!draft.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(draft.execution.id, approver).id);
    expect(out.state).toBe("failed");
  });
});
