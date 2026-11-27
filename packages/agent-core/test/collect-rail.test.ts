/**
 * The charging kits' `--rail api` through Collect's public routes (D1,
 * 27/11/2026; OPEN_QUESTIONS §69), over real HTTP through the SDK's client,
 * against a local server that answers the routes' documented shapes
 * (`fake-collect-api.ts`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { CollectChargeRail, collectReference, createCodeSparClient, dueInDays, payCollectLinkAsTestPayer, type RailPayment } from "../src/index.js";
import { startFakeCollect, type FakeCollect } from "./fake-collect-api.js";

const KEY = "csk_test_unit_0000";
const ACTOR = { type: "agent" as const, agent: "collections-agent@0.1.0", on_behalf_of: "merchant_demo_loja" };
const clock = () => new Date("2026-11-27T15:00:00.000Z");

let fake: FakeCollect | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function rig(options: Parameters<typeof startFakeCollect>[0] = {}, receiver?: string) {
  fake = await startFakeCollect(options);
  const api = createCodeSparClient({ apiKey: KEY, baseUrl: fake.url, timeoutMs: 5_000 });
  return { fake, api, rail: new CollectChargeRail(api, { clock, ...(receiver ? { receiver } : {}) }) };
}

function payment(over: Partial<RailPayment> = {}): RailPayment {
  return {
    attempt_id: "att_0123456789abcdef0123456789abcdef_0",
    mandate_id: "pol_1",
    amount_minor: 2700,
    currency: "BRL",
    payee: "52998224725",
    beneficiary: "Bruno Alves",
    purpose: "cobranca",
    description: "Acordo 1150 - parcela 1/1",
    agent_id: "collections-agent",
    consumer_id: "merchant_demo_loja",
    due_date: "2026-11-30",
    actor: ACTOR,
    ...over,
  };
}

const routes = (f: FakeCollect) => f.calls.map((c) => `${c.method} ${c.path.replace(/(cla?_|clr_)x*\d+/g, "$1…")}`);

describe("CollectChargeRail.pay: the link and its publish, under the attempt as the obligation's reference", () => {
  it("creates the link with the debtor's name only, days to the due date, the page surface, and no consumer_id unless one is configured", async () => {
    const { fake, rail } = await rig();
    const out = await rail.pay(payment());
    expect(out).toMatchObject({ status: "accepted", sandbox: true, instrument: { payable: true, pix_copy_paste: null, status: "link_published" } });
    if (out.status !== "accepted") throw new Error("not accepted");
    expect(out.transaction_id).toMatch(/^cl_/);
    expect(out.instrument.payment_url).toBe(`${fake.url}/c/${out.transaction_id}`);
    expect(routes(fake)).toEqual(["POST /v1/collect/links", "POST /v1/collect/links/cl_…/publish", "GET /v1/collect/cl_…"]);
    expect(fake.calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(fake.calls[0]!.body).toEqual({
      version: {
        title: "Acordo 1150 - parcela 1/1",
        items: [{ name: "Acordo 1150 - parcela 1/1", quantity: 1, unit_amount_minor: 2700 }],
        surfaces: ["page"],
        due_in_days: 3,
        payer_fields: { contact: "off", external_reference: "off" },
      },
      payer: { name: "Bruno Alves" },
      reference: "kit:att_0123456789abcdef0123456789abcdef_0",
      reference_version: "1",
    });
    // The debtor's document never travels: the payer states it on the page.
    expect(JSON.stringify(fake.calls[0]!.body)).not.toContain("52998224725");
  });

  it("names the receiving consumer when the kit is told which (CODESPAR_COLLECT_RECEIVER)", async () => {
    const { fake, rail } = await rig({}, "csm_receiver_1");
    await rail.pay(payment());
    expect((fake.calls[0]!.body as Record<string, unknown>)["consumer_id"]).toBe("csm_receiver_1");
  });

  it("the same attempt is the same link: a second presentation creates nothing", async () => {
    const { fake, rail } = await rig();
    const first = await rail.pay(payment());
    const second = await rail.pay(payment());
    expect(first.status === "accepted" && second.status === "accepted" && first.transaction_id === second.transaction_id).toBe(true);
    expect(fake.links.size).toBe(1);
  });

  it("a receiver that cannot receive leaves the link a draft and fails with the route's code; a later read says nothing was shown", async () => {
    const { fake, rail } = await rig({ receiverMissing: true });
    expect(await rail.pay(payment())).toMatchObject({ status: "failed", code: "receiving_identity_missing" });
    expect([...fake.links.values()].map((l) => l.state)).toEqual(["draft"]);
    expect(await rail.lookup(payment().attempt_id, payment())).toMatchObject({ status: "uncertain", needs_human: true });
  });

  it("a create whose answer was lost is uncertain, and the read finds the link by its reference instead of issuing again", async () => {
    const { fake, rail } = await rig({ createFailsAfterWrite: 1 });
    expect(await rail.pay(payment())).toMatchObject({ status: "uncertain", code: "internal_error" });
    // The draft exists and was never shown: a person decides; nothing is published from a read.
    expect(await rail.lookup(payment().attempt_id, payment())).toMatchObject({ status: "uncertain", needs_human: true });
    expect(fake.calls.at(-1)!.path).toBe("/v1/collect/links?reference=kit%3Aatt_0123456789abcdef0123456789abcdef_0&limit=5");
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("an API that priced another amount: the link is withdrawn and the charge fails", async () => {
    const { fake, rail } = await rig({ misprice: 2600 });
    expect(await rail.pay(payment())).toMatchObject({ status: "failed", code: "amount_mismatch" });
    expect([...fake.links.values()].map((l) => l.state)).toEqual(["archived"]);
    expect(routes(fake)).toContain("POST /v1/collect/links/cl_…/archive");
  });

  it("a live link is withdrawn and refused", async () => {
    const { fake, rail } = await rig({ environment: "live" });
    expect(await rail.pay(payment())).toMatchObject({ status: "failed", code: "live_key_refused" });
    expect([...fake.links.values()].map((l) => l.state)).toEqual(["archived"]);
  });

  it("a live key never reaches the network", async () => {
    fake = await startFakeCollect();
    expect(() => createCodeSparClient({ apiKey: ["csk", "live", "0000000000"].join("_"), baseUrl: fake!.url })).toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the Test payer and the read: from the link to the Collect receipt, credited once", () => {
  it("asks the page for its attempt with the fields the link left open, waits for the Pix, pays once; the read settles with the clr_ receipt", async () => {
    const { fake, api, rail } = await rig({ issuingReads: 2 });
    const issued = await rail.pay(payment());
    if (issued.status !== "accepted") throw new Error("not accepted");
    const linkId = issued.transaction_id;

    const paid = await payCollectLinkAsTestPayer(api, linkId, { sleep: async () => undefined });
    expect(paid).toMatchObject({ ok: true, payment: { object: "collect_test_payment", amount_minor: 2700, status: "PROCESSING" } });
    const asked = fake.calls.find((c) => c.method === "POST" && c.path === `/v1/collect/${linkId}/attempts`)!;
    // The name is the charger's (prefilled); the Test payer gives the document and the address, and no auth is needed on the page.
    expect(asked.body).toEqual({ page_session: `kitpay_${linkId}`, payer: { document: "52998224725", address: { publicArea: "Rua das Flores", number: "100", neighborhood: "Centro", city: "Recife", state: "PE", postalCode: "50010000" } }, renew: false });
    const testPay = fake.calls.filter((c) => c.path.endsWith("/test-pay"));
    expect(testPay).toHaveLength(1);
    expect(testPay[0]!.body).toBeUndefined();

    const seen = await rail.lookup(payment().attempt_id, payment(), linkId);
    expect(seen).toMatchObject({ status: "settled", transaction_id: linkId, money_moved: false, sandbox: true });
    if (!seen || seen.status !== "settled") throw new Error("not settled");
    expect(seen.receipt_id).toMatch(/^clr_/);

    const receipt = await rail.receipt(seen.receipt_id!, ACTOR);
    expect(receipt).toMatchObject({ receipt_id: seen.receipt_id, kind: "charge", state: "paid", payment: { amount_minor: 2700, payee: null, money_moved: false, sandbox: true }, receipt_sig_ed25519: null, chain: null });
    expect((receipt!.raw as { credits: { paid: number; exceptions: number; ledger_entry_ids: string[] } }).credits).toMatchObject({ paid: 1, exceptions: 0 });
    expect(routes(fake).at(-1)).toBe("GET /v1/collect/links/cl_…/payments");
  });

  it("an open attempt with its Pix is shown before it is paid: the read carries the copia-e-cola", async () => {
    const { api, rail } = await rig({ issuingReads: 1 });
    const issued = await rail.pay(payment());
    if (issued.status !== "accepted") throw new Error("not accepted");
    await api.post("/v1/collect/{linkId}/attempts", { path: { linkId: issued.transaction_id }, body: { page_session: "person_session_0001", payer: { document: "52998224725", address: { publicArea: "R", number: "1", neighborhood: "C", city: "Recife", state: "PE", postalCode: "50010000" } } } });
    await api.get("/v1/collect/{linkId}", { path: { linkId: issued.transaction_id } });
    const seen = await rail.lookup(payment().attempt_id, payment(), issued.transaction_id);
    expect(seen).toMatchObject({ status: "accepted", instrument: { payable: true, status: "attempt_open", due_date: "2026-11-28" } });
    expect(seen?.status === "accepted" && seen.instrument.pix_copy_paste).toMatch(/^000201/);
  });

  it("the provider's sandbox refusing the Pix: the pay route is never called", async () => {
    const { fake, api, rail } = await rig({ attemptFails: true });
    const issued = await rail.pay(payment());
    if (issued.status !== "accepted") throw new Error("not accepted");
    expect(await payCollectLinkAsTestPayer(api, issued.transaction_id, { sleep: async () => undefined })).toMatchObject({ ok: false, code: "collect_attempt_failed" });
    expect(fake.calls.some((c) => c.path.endsWith("/test-pay"))).toBe(false);
  });

  it("a Test payment whose step failed is never asked again: the claim stays, a second press is refused, and nothing settles", async () => {
    const { fake, api, rail } = await rig({ testPayFails: "test_pay_decode_failed" });
    const issued = await rail.pay(payment());
    if (issued.status !== "accepted") throw new Error("not accepted");
    const first = await payCollectLinkAsTestPayer(api, issued.transaction_id, { sleep: async () => undefined });
    expect(first).toMatchObject({ ok: false, code: "test_pay_decode_failed" });
    if (first.ok) throw new Error("paid");
    expect(first.message).toContain("does not ask again");
    expect(fake.calls.filter((c) => c.path.endsWith("/test-pay"))).toHaveLength(1);
    expect(await payCollectLinkAsTestPayer(api, issued.transaction_id, { sleep: async () => undefined })).toMatchObject({ ok: false, code: "test_pay_already_used" });
    expect(await rail.lookup(payment().attempt_id, payment(), issued.transaction_id)).toMatchObject({ status: "accepted" });
    expect(fake.payments).toHaveLength(0);
  });

  it("an attempt still issuing when the wait ends: refused before the pay route", async () => {
    const { fake, api, rail } = await rig({ issuingReads: 1000 });
    const issued = await rail.pay(payment());
    if (issued.status !== "accepted") throw new Error("not accepted");
    expect(await payCollectLinkAsTestPayer(api, issued.transaction_id, { waitMs: 0, sleep: async () => undefined })).toMatchObject({ ok: false, code: "no_payable_instrument" });
    expect(fake.calls.some((c) => c.path.endsWith("/test-pay"))).toBe(false);
  });

  it("a link withdrawn unpaid is a cancelled charge", async () => {
    const { api, rail } = await rig();
    const issued = await rail.pay(payment());
    if (issued.status !== "accepted") throw new Error("not accepted");
    await api.post("/v1/collect/links/{linkId}/archive", { path: { linkId: issued.transaction_id } });
    expect(await rail.lookup(payment().attempt_id, payment(), issued.transaction_id)).toMatchObject({ status: "failed", code: "charge_cancelled" });
  });
});

describe("the small rules", () => {
  it("a charge due today is due in one day; the days are held to 1..60", () => {
    expect(dueInDays("2026-11-27", "2026-11-27")).toBe(1);
    expect(dueInDays("2026-11-30", "2026-11-27")).toBe(3);
    expect(dueInDays("2027-06-01", "2026-11-27")).toBe(60);
  });

  it("the reference is the attempt, in the characters Collect takes", () => {
    expect(collectReference("att_x_0")).toBe("kit:att_x_0");
    expect(() => collectReference("att x")).toThrow();
  });
});
