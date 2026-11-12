/**
 * The pull rail, offline. A fake bank implements the rail's four calls in
 * memory and records each one, so what is tested is the rail itself: the
 * payment made once and only once, the claims two readers race for, and the
 * bank's outcomes read as the core's reasons.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StateStore, type RailPayment } from "@codespar/agent-core";
import {
  FixtureSweepingApi,
  SweepingApiError,
  SweepingPullRail,
  sweepingLimits,
  type AuthorizationRequest,
  type AuthorizationView,
  type PaymentRequest,
  type PaymentView,
  type SweepingApi,
  type SweepingRailConfig,
} from "../src/modules/sweeping-pull.js";

const tempDirs: string[] = [];
function store(path?: string): StateStore {
  if (path) return new StateStore(path);
  const dir = mkdtempSync(join(tmpdir(), "topup-rail-"));
  tempDirs.push(dir);
  return new StateStore(join(dir, "state.db"));
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const CONFIG: SweepingRailConfig = {
  creditorId: "creditor-test",
  triggerId: "trigger-manual",
  participantId: "participant-banco-de-testes",
  taxId: "00000000000",
  limits: { total_minor: 1000, per_tx_minor: 500 },
  riskSignals: () => ({ type: "MANUAL", deviceId: "0011223344556677", osVersion: "6.8.0", userTimeZoneOffset: "-03", language: "pt", screenDimensions: { height: 1080, width: 1920 }, accountTenure: "2026-10-21" }),
};

const AUTH_ID = "urn:fake:auth-1";
const PAY_ID = "pay-1";
const E2E = "E00000000202610222049abcdef12345";
const LINK = "https://bank.example/consent?request_uri=urn:x";

function payment(over: Partial<RailPayment> = {}): RailPayment {
  return {
    attempt_id: "att_1",
    mandate_id: "pol_topup",
    amount_minor: 100,
    currency: "BRL",
    payee: "creditor-test",
    purpose: "topup",
    agent_id: "topup-agent",
    actor: { type: "agent", agent: "topup-agent", on_behalf_of: "usr_demo" },
    ...over,
  };
}

type Op = "createAuthorization" | "getAuthorization" | "createPayment" | "getPaymentStatus";
interface Call {
  op: Op;
  body: AuthorizationRequest | PaymentRequest | null;
}

/** A fake bank behind the rail's four calls. `authStatus` is what the bank says about the authorization at each read. */
function fakeBank(options: { authStatus?: string[]; rejection?: string; paymentCreate?: "ok" | "lost" | "422" | "429"; authRead?: 401 | 404 | 429 | 503; paymentStatus?: 403 | 429; slowPaymentMs?: number; authCreateLostOnce?: boolean } = {}) {
  const calls: Call[] = [];
  const authStatus = [...(options.authStatus ?? ["AUTHORISED"])];
  let loseAuthCreate = options.authCreateLostOnce ?? false;
  const refused = (status: number, what: string) => new SweepingApiError(status, `http_${status}`, `${what} -> ${status}`);
  const api: SweepingApi = {
    async createAuthorization(r: AuthorizationRequest): Promise<AuthorizationView> {
      calls.push({ op: "createAuthorization", body: r });
      if (loseAuthCreate) {
        loseAuthCreate = false;
        throw new SweepingApiError(0, "network", "create authorization: no answer");
      }
      return { authorizationId: AUTH_ID, status: "AWAITING_AUTHORISATION", authUrl: LINK, rejection: null };
    },
    async getAuthorization(id: string): Promise<AuthorizationView> {
      calls.push({ op: "getAuthorization", body: null });
      if (id !== AUTH_ID) throw refused(404, "read authorization");
      if (options.authRead) throw refused(options.authRead, "read authorization");
      const status = authStatus.length > 1 ? authStatus.shift()! : authStatus[0]!;
      // The link comes back with the status while the bank waits, and not after.
      return { authorizationId: AUTH_ID, status, authUrl: status === "AWAITING_AUTHORISATION" ? LINK : null, rejection: options.rejection ?? null };
    },
    async createPayment(_id: string, r: PaymentRequest): Promise<PaymentView> {
      calls.push({ op: "createPayment", body: r });
      if (options.paymentCreate === "lost") throw new SweepingApiError(0, "network", "create payment: no answer");
      if (options.slowPaymentMs) await new Promise((done) => setTimeout(done, options.slowPaymentMs));
      if (options.paymentCreate === "429") throw refused(429, "create payment");
      if (options.paymentCreate === "422") throw refused(422, "create payment");
      return { id: PAY_ID, status: "CONSENT_AUTHORIZED", endToEndId: E2E };
    },
    async getPaymentStatus(_id: string, paymentId: string): Promise<PaymentView> {
      calls.push({ op: "getPaymentStatus", body: null });
      if (options.paymentStatus) throw refused(options.paymentStatus, "read payment");
      if (paymentId !== PAY_ID) throw refused(404, "read payment");
      return { id: PAY_ID, status: "PAYMENT_COMPLETED", endToEndId: E2E };
    },
  };
  const count = (op: Op) => calls.filter((c) => c.op === op).length;
  return { api, calls, count };
}

describe("the error's two readings", () => {
  it("a write is uncertain only with no answer or a 5xx; a read is looked at again also on a 401, 408 or 429", () => {
    expect(new SweepingApiError(429, "rate_limited", "x").uncertain).toBe(false);
    expect(new SweepingApiError(408, "timeout", "x").uncertain).toBe(false);
    expect(new SweepingApiError(503, "unavailable", "x").uncertain).toBe(true);
    expect(new SweepingApiError(0, "no_answer", "x").uncertain).toBe(true);
    for (const status of [0, 401, 408, 429, 503]) expect(new SweepingApiError(status, "x", "x").transientRead, String(status)).toBe(true);
    for (const status of [403, 404, 422]) expect(new SweepingApiError(status, "x", "x").transientRead, String(status)).toBe(false);
  });
});

describe("the pull rail", () => {
  it("pay() creates the authorization and answers accepted with the consent link; the looks pay once and settle on the end-to-end id", async () => {
    const fake = fakeBank({ authStatus: ["AWAITING_AUTHORISATION", "AUTHORISED"] });
    const rail = new SweepingPullRail(store(), fake.api, CONFIG, true);
    const accepted = await rail.pay(payment());
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;
    expect(accepted.transaction_id).toBe(AUTH_ID);
    expect(accepted.instrument.consent_url).toBe(LINK);
    expect(accepted.instrument.payable).toBe(true);

    const waiting = await rail.lookup("att_1", payment());
    expect(waiting?.status).toBe("accepted");
    const settled = await rail.lookup("att_1", payment());
    expect(settled).toMatchObject({ status: "settled", transaction_id: E2E, receipt_id: "pay-1", sandbox: true, money_moved: false });
    // A later look answers from the record: no second payment, no second read.
    const before = fake.calls.length;
    expect((await rail.lookup("att_1", payment()))?.status).toBe("settled");
    expect(fake.calls.length).toBe(before);
    expect(fake.count("createPayment")).toBe(1);
    const pull = fake.calls.find((c) => c.op === "createPayment")!.body as PaymentRequest;
    expect(pull).toMatchObject({ amount: 100, creditorId: "creditor-test", triggerId: "trigger-manual", externalId: "att_1-pull" });
    expect(pull.riskSignals.type).toBe("MANUAL");
    // The authorization carries the same two limits the mandate holds, for the configured creditor and trigger.
    expect(fake.count("createAuthorization")).toBe(1);
    const asked = fake.calls.find((c) => c.op === "createAuthorization")!.body as AuthorizationRequest;
    expect(asked).toMatchObject({ externalId: "att_1", totalAllowedAmount: 1000, transactionLimit: 500, creditorId: "creditor-test", triggerId: "trigger-manual" });

    const receipt = await rail.receipt("pay-1", payment().actor);
    expect(receipt).toMatchObject({ kind: "charge", receipt_sig: null, receipt_sig_ed25519: null, chain: null, payment: { amount_minor: 100, payee: "creditor-test" } });
  });

  it("presenting the same attempt again creates nothing new", async () => {
    const fake = fakeBank({ authStatus: ["AWAITING_AUTHORISATION"] });
    const rail = new SweepingPullRail(store(), fake.api, CONFIG, true);
    await rail.pay(payment());
    await rail.pay(payment());
    expect(fake.count("createAuthorization")).toBe(1);
  });

  it("a payment request whose answer was lost is never sent again: every later look is uncertain", async () => {
    const fake = fakeBank({ paymentCreate: "lost" });
    const rail = new SweepingPullRail(store(), fake.api, CONFIG, true);
    await rail.pay(payment());
    expect((await rail.lookup("att_1", payment()))?.status).toBe("uncertain");
    expect((await rail.lookup("att_1", payment()))).toMatchObject({ status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true });
    expect(fake.count("createPayment")).toBe(1);
  });

  it("a rate-limited payment request is a certain refusal: the attempt fails and no marker is left unresolved", async () => {
    const fake = fakeBank({ paymentCreate: "429" });
    const rail = new SweepingPullRail(store(), fake.api, CONFIG, true);
    await rail.pay(payment());
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "charge_issuer_error" });
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "failed" });
    expect(fake.count("createPayment")).toBe(1);
  });

  it("an authorization request with no answer leaves a record, and the next look makes it again under the same externalId", async () => {
    const fake = fakeBank({ authCreateLostOnce: true });
    const rail = new SweepingPullRail(store(), fake.api, CONFIG, true);
    expect(await rail.pay(payment())).toMatchObject({ status: "uncertain", code: "authorization_unconfirmed" });
    // Not "unknown to the rail": the attempt is on record, and a look re-issues it.
    const looked = await rail.lookup("att_1", payment());
    expect(looked).toMatchObject({ status: "accepted", transaction_id: AUTH_ID, instrument: { consent_url: LINK } });
    const creates = fake.calls.filter((c) => c.op === "createAuthorization");
    expect(creates).toHaveLength(2);
    expect(creates.map((c) => c.body?.externalId)).toEqual(["att_1", "att_1"]);
    // Issued once it answered: later looks read it, they do not make another.
    await rail.lookup("att_1", payment());
    expect(fake.count("createAuthorization")).toBe(2);
  });

  it("a clear refusal to read the authorization fails the attempt; a 5xx stays uncertain and is looked at again", async () => {
    const refused = new SweepingPullRail(store(), fakeBank({ authRead: 404 }).api, CONFIG, true);
    await refused.pay(payment());
    expect(await refused.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "authorization_unreadable" });

    const flaky = new SweepingPullRail(store(), fakeBank({ authRead: 503 }).api, CONFIG, true);
    await flaky.pay(payment());
    const seen = await flaky.lookup("att_1", payment());
    expect(seen).toMatchObject({ status: "uncertain", code: "authorization_unreadable" });
    expect(seen && "needs_human" in seen).toBe(false);
  });

  it("a 429 or a 401 reading the authorization is looked at again, never final; a 429 reading the payment does not call a human", async () => {
    for (const status of [429, 401] as const) {
      const rail = new SweepingPullRail(store(), fakeBank({ authRead: status }).api, CONFIG, true);
      await rail.pay(payment());
      const seen = await rail.lookup("att_1", payment());
      expect(seen, String(status)).toMatchObject({ status: "uncertain", code: "authorization_unreadable" });
      expect(seen && "needs_human" in seen, String(status)).toBe(false);
      // Not recorded as final: the next look asks the bank again.
      expect((await rail.lookup("att_1", payment()))?.status, String(status)).toBe("uncertain");
    }
    const fake = fakeBank({ paymentStatus: 429 });
    const rail = new SweepingPullRail(store(), fake.api, CONFIG, true);
    await rail.pay(payment());
    const seen = await rail.lookup("att_1", payment());
    expect(seen).toMatchObject({ status: "uncertain", code: "payment_unreadable" });
    expect(seen && "needs_human" in seen).toBe(false);
    expect(fake.count("createPayment")).toBe(1);
  });

  it("a clear refusal to read a payment already requested stops at a human, never failed: the money may have moved", async () => {
    const fake = fakeBank({ paymentStatus: 403 });
    const rail = new SweepingPullRail(store(), fake.api, CONFIG, true);
    await rail.pay(payment());
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "uncertain", code: "payment_unreadable", needs_human: true });
    expect(fake.count("createPayment")).toBe(1);
  });

  it("two readers that both see AUTHORISED send one payment request: the marker is claimed once, the other reads it in flight", async () => {
    const fake = fakeBank({ slowPaymentMs: 50 });
    const first = store();
    // Two handles on the same state.db, as two processes would have.
    const shared = store(first.path);
    const a = new SweepingPullRail(first, fake.api, CONFIG, true);
    const b = new SweepingPullRail(shared, fake.api, CONFIG, true);
    await a.pay(payment());
    const [seenA, seenB] = await Promise.all([a.lookup("att_1", payment()), b.lookup("att_1", payment())]);
    expect(fake.count("createPayment")).toBe(1);
    expect([seenA?.status, seenB?.status].sort()).toEqual(["in_flight", "settled"]);
    // Once the first answer is on disk, the other reader sees the same payment settle.
    expect(await b.lookup("att_1", payment())).toMatchObject({ status: "settled" });
  });

  it("an expired link fails as charge_expired, a rejected one as charge_cancelled", async () => {
    const expired = new SweepingPullRail(store(), fakeBank({ authStatus: ["REJECTED"], rejection: "REJEITADO_TEMPO_EXPIRADO_ACCOUNT_HOLDER_VALIDATION" }).api, CONFIG, true);
    await expired.pay(payment());
    expect(await expired.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "charge_expired" });
    const rejected = new SweepingPullRail(store(), fakeBank({ authStatus: ["REJECTED"], rejection: "REJEITADO_USUARIO" }).api, CONFIG, true);
    await rejected.pay(payment());
    expect(await rejected.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "charge_cancelled" });
  });

  it("refuses, before any call, a payee that is not the creditor and an amount above the transaction limit", async () => {
    const fake = fakeBank();
    const rail = new SweepingPullRail(store(), fake.api, CONFIG, true);
    expect(await rail.pay(payment({ payee: "someone-else" }))).toMatchObject({ status: "failed", code: "creditor_mismatch" });
    expect(await rail.pay(payment({ amount_minor: 501 }))).toMatchObject({ status: "failed", code: "above_transaction_limit" });
    expect(fake.calls).toHaveLength(0);
  });

  it("the offline fixture runs the same cycle with no network", async () => {
    const s = store();
    const rail = new SweepingPullRail(s, new FixtureSweepingApi(s), CONFIG, true);
    expect((await rail.pay(payment())).status).toBe("accepted");
    expect((await rail.lookup("att_1", payment()))?.status).toBe("settled");
  });
});

describe("the limits", () => {
  it("one reading for the bank and the mandate, defaults R$ 10,00 total and R$ 5,00 per pull", () => {
    expect(sweepingLimits({})).toEqual({ total_minor: 1000, per_tx_minor: 500 });
    expect(sweepingLimits({ TOPUP_TOTAL_CENTS: "2000", TOPUP_TX_LIMIT_CENTS: "300" })).toEqual({ total_minor: 2000, per_tx_minor: 300 });
    expect(() => sweepingLimits({ TOPUP_TX_LIMIT_CENTS: "2000" })).toThrow(/cannot exceed/);
    expect(() => sweepingLimits({ TOPUP_TOTAL_CENTS: "10.5" })).toThrow(/positive integer/);
  });
});

describe("the bank's link is not kept in state.db", () => {

  it("the record holds ids and statuses only; after a restart the link comes back from the authorization read", async () => {
    const s = store();
    const fake = fakeBank({ authStatus: ["AWAITING_AUTHORISATION", "AUTHORISED"] });
    const first = await new SweepingPullRail(s, fake.api, CONFIG, true).pay(payment());
    expect(first).toMatchObject({ status: "accepted", instrument: { consent_url: LINK } });
    const atRest = s.getCursor("sweeping:att_1") ?? "";
    for (const piece of ["request_uri", "bank.example", "auth_url"]) expect(atRest).not.toContain(piece);
    // A new process over the same state.db, the bank still waiting: the link again, read from the bank.
    const restarted = new SweepingPullRail(s, fake.api, CONFIG, true);
    expect(await restarted.lookup("att_1", payment())).toMatchObject({ status: "accepted", instrument: { consent_url: LINK } });
    expect(fake.count("createAuthorization")).toBe(1);
  });

  it("a record written with the link by an earlier version loses it at its next write, and the pull goes on", async () => {
    const s = store();
    const fake = fakeBank({ authStatus: ["AUTHORISED"] });
    const rail = new SweepingPullRail(s, fake.api, CONFIG, true);
    await rail.pay(payment());
    s.setCursor("sweeping:att_1", JSON.stringify({ ...JSON.parse(s.getCursor("sweeping:att_1")!), auth_url: LINK }));
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "settled" });
    expect(s.getCursor("sweeping:att_1")).not.toContain("request_uri");
  });

  it("the offline fixture answers the link while it waits", async () => {
    const s = store();
    const api = new FixtureSweepingApi(s);
    const created = await api.createAuthorization({ externalId: "att_1" } as Parameters<FixtureSweepingApi["createAuthorization"]>[0]);
    expect(created.authUrl).toMatch(/request_uri=/);
  });
});
