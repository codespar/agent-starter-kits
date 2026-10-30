/**
 * Section 11: what the proof bundle has to carry for `npm run inspect` to
 * answer "why could the agent pay this" from the folder alone — the rail's
 * request and its answer per attempt, and a receipt path that travels with
 * the bundle instead of naming the machine that wrote it.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { maskPayee, ProofBundle } from "../src/bundle.js";
import { itemsHash } from "../src/hash.js";
import { ReplayRuntime } from "../src/providers/replay.js";
import { refusedDispatchesOf, type StubRailOptions } from "../src/stubs/rail.js";
import { ESCOLA, FUNCIONARIA, harness, MERCADO, testMandate } from "./helpers.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Another phone key that masks exactly like MERCADO: `+551***0001`. */
const MERCADO_TWIN = "+5511888880001";

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
  it("no file of a run that escalated, settled, was refused and talked names a mandate payee in the clear, but the tool calls a rerun replays", async () => {
    // In mandate mode the first payment to mercado escalates with a detail that names its key, and the rail's refusal of escola names escola's.
    const h = harness({ mode: "mandate", rail: { refusePayees: [ESCOLA] } });
    h.bundle.mandateSnapshot(h.engine.mandate);
    const big = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    const small = await h.engine.draft({ items: [{ payee: "mercado", amount: 1000 }] });
    if (!big.ok || !small.ok) throw new Error("refused");
    await h.engine.execute(h.engine.approve(big.execution.id, approver).id);
    await h.engine.execute(h.engine.approve(small.execution.id, approver).id);
    // The model's side and the conversation, each naming every key.
    const named = `${ESCOLA}, ${MERCADO} e ${FUNCIONARIA}`;
    const call = { id: "tc_1", name: "codespar_pay", input: { action: "pay", items: [{ payee: MERCADO, amount_minor: 1000 }] } };
    h.bundle.transcript({ at: "t", kind: "user", text: `paga ${named}` });
    h.bundle.transcript({ at: "t", kind: "assistant_step", tool_calls: [call] });
    h.bundle.transcript({ at: "t", kind: "tool_call", tool_call_id: "tc_1", name: "codespar_pay", input: call.input });
    h.bundle.transcript({ at: "t", kind: "tool_result", tool_call_id: "tc_1", name: "codespar_pay", content: JSON.stringify({ payee: ESCOLA }) });
    h.bundle.transcript({ at: "t", kind: "assistant_step", reply: `Paguei ${named}.` });
    h.bundle.channel({ direction: "in", contact: "+55***4321", text: `paga ${named}`, channel: "whatsapp" });
    h.bundle.channel({ direction: "out", contact: "+55***4321", text: `Paguei ${named}.`, channel: "whatsapp" });

    const payees = [...h.engine.mandate.beneficiaries.map((b) => b.payee), ...h.engine.mandate.merchant_allowlist].filter((p) => p !== "*");
    // The free text is there, with the key masked inside it.
    const log = readFileSync(join(h.bundle.dir, "events.jsonl"), "utf8");
    expect(log).toContain(`(${maskPayee(MERCADO)}) under this mandate`);
    expect(log).toContain(`refused payee ${maskPayee(ESCOLA)}`);
    const files = filesUnder(h.bundle.dir);
    expect(files.map((f) => f.slice(h.bundle.dir.length + 1))).toEqual(expect.arrayContaining(["events.jsonl", "approval.json", "mandate.snapshot.json", "transcript.jsonl", "channel.jsonl"]));
    // The one exception, by name: `tool_calls` and `input` in transcript.jsonl, which hold MERCADO here.
    const exempt = (file: string, text: string) =>
      file.endsWith("transcript.jsonl")
        ? text
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const { tool_calls: _calls, input: _input, ...rest } = JSON.parse(l) as Record<string, unknown>;
              return JSON.stringify(rest);
            })
            .join("\n")
        : text;
    for (const file of files) {
      const raw = readFileSync(file, "utf8");
      const text = exempt(file, raw);
      for (const payee of payees) expect(text.includes(payee), `${payee} in ${file}`).toBe(false);
    }
    expect(readFileSync(join(h.bundle.dir, "transcript.jsonl"), "utf8")).toContain(MERCADO);
  });

  it("a step's reply is masked, and a rerun replays the masked text, which ends the turn all the same", async () => {
    const h = harness({ mode: "human" });
    h.bundle.mandateSnapshot(h.engine.mandate);
    h.bundle.transcript({ at: "t", kind: "assistant_step", reply: `Paguei ${MERCADO}.` });
    const replay = ReplayRuntime.fromLines(h.bundle.readTranscript());
    expect(await replay.step({} as never, [])).toEqual({ text: `Paguei ${maskPayee(MERCADO)}.` });
  });

  it("a bundle reopened by another process masks a key by its shape, without having seen the mandate", () => {
    const h = harness({ mode: "human" });
    const reopened = ProofBundle.open(join(h.dir, "runs"), "run_test")!;
    const evp = "123e4567-e89b-42d3-a456-426614174000";
    const detail = `to ${ESCOLA}, ${MERCADO}, ${FUNCIONARIA}, 11222333000181, 12.345.678/0001-95, 11144477735 and ${evp}; execution exe_${evp}, R$ 1850,00, at 1759000000000`;
    reopened.event({ type: "test.event", payload: { detail } });
    const written = (reopened.readEvents()[0]!["payload"] as { detail: string }).detail;
    expect(written).toBe(
      `to ${maskPayee(ESCOLA)}, ${maskPayee(MERCADO)}, ${maskPayee(FUNCIONARIA)}, ${maskPayee("11222333000181")}, ${maskPayee("12.345.678/0001-95")}, ${maskPayee("11144477735")} and ${maskPayee(evp)}; execution exe_${evp}, R$ 1850,00, at 1759000000000`,
    );
    // Masking again changes nothing.
    reopened.event({ type: "test.event", payload: { detail: written } });
    expect((reopened.readEvents()[1]!["payload"] as { detail: string }).detail).toBe(written);
  });

  it("a short key is masked in its payee field and never searched for inside prose", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-core-short-"));
    tempDirs.push(dir);
    const bundle = new ProofBundle(dir, "run_short");
    bundle.event({ type: "test.event", payload: { payee: "12300", detail: "paid 12300 of R$ 123000" } });
    bundle.event({ type: "test.event", payload: { payee: "ab", detail: "ab is a short key" } });
    const [first, second] = bundle.readEvents().map((e) => e["payload"] as { payee: string; detail: string });
    expect(first).toEqual({ payee: "12***", detail: "paid 12300 of R$ 123000" });
    expect(second).toEqual({ payee: "***", detail: "ab is a short key" });
  });

  it("channel.jsonl masks a key a message names", () => {
    const h = harness({ mode: "human" });
    h.bundle.mandateSnapshot(h.engine.mandate);
    h.bundle.channel({ direction: "in", contact: "+55***4321", text: `paga o ${MERCADO}` });
    expect(h.bundle.readChannel()[0]).toEqual({ direction: "in", contact: "+55***4321", text: `paga o ${maskPayee(MERCADO)}` });
  });

  it("approval.json is the artifact with its payees masked, its hash and signature untouched, and the full one stays in state.db", async () => {
    const { h } = await settledRun();
    const [copy] = h.bundle.readApprovals();
    const full = h.store.getApproval(copy!.approval_id)!;
    expect(copy!.payee_masked).toBe(true);
    expect(copy!.items.map((i) => i.payee)).toEqual([maskPayee(ESCOLA)]);
    expect(copy!.items_hash).toBe(full.items_hash);
    // The masked list hashes to the copy's own items_hash_masked, so an edit to it shows.
    expect(copy!.items_hash_masked).toBe(itemsHash(copy!.items));
    expect(copy!.items_hash_masked).not.toBe(full.items_hash);
    expect(copy!.signature).toEqual(full.signature);
    expect(full.items.map((i) => i.payee)).toEqual([ESCOLA]);
    expect(full.payee_masked).toBeUndefined();
  });

  it("masks a key inside prose fields only: an id or a hash that contains one is written byte for byte", () => {
    const h = harness({ mode: "human" });
    h.bundle.mandateSnapshot(h.engine.mandate);
    // Every field but `detail` holds the full key as a substring; split/join over every string rewrote them all.
    const payload = { attempt_id: `att_${MERCADO}_0`, idempotency_key: `idk_${MERCADO}`, receipt_id: `rcpt_${MERCADO}`, path: `receipts/${MERCADO}.json`, detail: `first payment to Mercado (${MERCADO})`, held: { by: `exe_${MERCADO}` } };
    h.bundle.event({ type: "test.event", payload });
    const [written] = h.bundle.readEvents() as Array<{ payload: typeof payload }>;
    expect(written!.payload).toEqual({ ...payload, detail: `first payment to Mercado (${maskPayee(MERCADO)})` });
  });

  it("masks the transcript's turns and tool results, and leaves the tool calls a rerun replays as they were recorded", () => {
    const h = harness({ mode: "human" });
    h.bundle.mandateSnapshot(h.engine.mandate);
    const call = { id: "tc_1", name: "codespar_pay", input: { action: "pay", items: [{ payee: MERCADO, amount_minor: 1000 }] } };
    h.bundle.transcript({ at: "t", kind: "user", text: `paga o ${MERCADO}` });
    h.bundle.transcript({ at: "t", kind: "assistant_step", tool_calls: [call] });
    h.bundle.transcript({ at: "t", kind: "tool_call", tool_call_id: "tc_1", name: "codespar_pay", input: call.input });
    h.bundle.transcript({ at: "t", kind: "tool_result", tool_call_id: "tc_1", name: "codespar_pay", refused: false, content: JSON.stringify({ paid: true, payee: MERCADO }) });
    h.bundle.transcript({ at: "t", kind: "assistant", text: `Paguei ${MERCADO}.` });
    const [user, step, toolCall, result, reply] = h.bundle.readTranscript();
    expect(user!["text"]).toBe(`paga o ${maskPayee(MERCADO)}`);
    expect(step!["tool_calls"]).toEqual([call]);
    expect(toolCall!["input"]).toEqual(call.input);
    expect(result!["content"]).toBe(JSON.stringify({ paid: true, payee: maskPayee(MERCADO) }));
    expect(reply!["text"]).toBe(`Paguei ${maskPayee(MERCADO)}.`);
  });

  it("the stub rail refuses by the full key only: a masked key matches nothing", async () => {
    const h = harness({ mode: "human", rail: { refusePayees: [maskPayee(ESCOLA)] } });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!draft.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(draft.execution.id, approver).id);
    expect(out.state).toBe("settled");
  });

  it("two keys that share a mask: the refusal of one is replayed from the bundle without refusing the other", async () => {
    expect(maskPayee(MERCADO_TWIN)).toBe(maskPayee(MERCADO));
    const base = testMandate();
    const mandate = { merchant_allowlist: [...base.merchant_allowlist, MERCADO_TWIN], beneficiaries: [...base.beneficiaries, { alias: "mercado2", name: "Mercado Dois", payee: MERCADO_TWIN }] };
    const run = async (rail: StubRailOptions) => {
      const h = harness({ mode: "human", mandate, rail });
      const states: string[] = [];
      for (const alias of ["mercado", "mercado2"]) {
        const draft = await h.engine.draft({ items: [{ payee: alias, amount: 1000 }] });
        if (!draft.ok) throw new Error("refused");
        states.push((await h.engine.execute(h.engine.approve(draft.execution.id, approver).id)).state);
      }
      return { h, states };
    };
    const original = await run({ refusePayees: [MERCADO] });
    expect(original.states).toEqual(["failed", "settled"]);
    const events = original.h.bundle.readEvents();
    // The bundle cannot tell the two apart by payee.
    expect(new Set(events.filter((e) => e["type"] === "rail.dispatch").map((e) => (e["payload"] as { payee: string }).payee))).toEqual(new Set([maskPayee(MERCADO)]));
    const refused = refusedDispatchesOf(events);
    expect(refused).toEqual([0]);
    expect((await run({ refuseDispatches: refused })).states).toEqual(["failed", "settled"]);
  });
});
