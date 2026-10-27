/**
 * The Iniciador client and the pull rail, offline. A fake sweeping API answers
 * over a fake `fetch` with the shapes the sandbox answered on 2026-10-22, so
 * what is tested is the real HTTP client: the token kept in memory and
 * refreshed on a 401, the errors scrubbed of every secret, the payment made
 * once and only once, and the bank's outcomes read as the core's reasons.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StateStore, type RailPayment } from "@codespar/agent-core";
import { HttpSweepingApi, IniciadorError, scrub } from "../src/iniciador.js";
import { FixtureSweepingApi, SweepingPullRail, sweepingLimits, type SweepingRailConfig } from "../src/modules/sweeping-pull.js";

const tempDirs: string[] = [];
function store(): StateStore {
  const dir = mkdtempSync(join(tmpdir(), "topup-rail-"));
  tempDirs.push(dir);
  return new StateStore(join(dir, "state.db"));
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const CLIENT_ID = "fake-client-id-123456";
const CLIENT_SECRET = "fake-secret-abcdef-7890";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlLWZha2U";
const TAX_ID = "12345678909";
const BASE = "http://127.0.0.1:18787/v1";

const CONFIG: SweepingRailConfig = {
  creditorId: "creditor-test",
  triggerId: "trigger-manual",
  participantId: "participant-banco-de-testes",
  taxId: TAX_ID,
  limits: { total_minor: 1000, per_tx_minor: 500 },
  riskSignals: () => ({ type: "MANUAL", deviceId: "0011223344556677", osVersion: "6.8.0", userTimeZoneOffset: "-03", language: "pt", screenDimensions: { height: 1080, width: 1920 }, accountTenure: "2026-10-21" }),
};

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

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}

/** A fake sweeping API behind `fetch`. `auth` decides what the bank does with each authorization when it is next read. */
function fakeIniciador(options: { authStatus?: string[]; rejection?: string; paymentCreate?: "ok" | "lost" | "422"; expireTokenOnce?: boolean; authRead?: 404 | 503; paymentStatus?: 403 } = {}) {
  const calls: Call[] = [];
  const authStatus = [...(options.authStatus ?? ["AUTHORISED"])];
  let tokens = 0;
  let expireOnce = options.expireTokenOnce ?? false;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"] ?? null;
    calls.push({ method: init?.method ?? "GET", path, body, auth });
    if (path === "/sweeping/auth") {
      tokens += 1;
      return json(201, { accessToken: TOKEN });
    }
    if (auth !== `Bearer ${TOKEN}`) return json(401, { message: "unauthorized" });
    if (expireOnce) {
      expireOnce = false;
      return json(401, { message: "token expired" });
    }
    if (init?.method === "POST" && path === "/sweeping/authorizations") {
      return json(201, { id: "a1", authorizationId: "urn:Iniciador:auth-1", status: "AWAITING_AUTHORISATION", authUrl: "https://bank.example/consent?request_uri=urn:x", user: { taxId: body?.["user"] } });
    }
    if (init?.method === "GET" && path === "/sweeping/authorizations/urn%3AIniciador%3Aauth-1") {
      if (options.authRead) return json(options.authRead, { message: "authorization read refused" });
      const status = authStatus.length > 1 ? authStatus.shift()! : authStatus[0]!;
      return json(200, { authorizationId: "urn:Iniciador:auth-1", status, ...(options.rejection ? { rejection: { reason: { code: options.rejection } } } : {}) });
    }
    if (init?.method === "POST" && path === "/sweeping/authorizations/urn%3AIniciador%3Aauth-1/payments") {
      if (options.paymentCreate === "lost") throw new TypeError("fetch failed");
      if (options.paymentCreate === "422") return json(422, { errorCode: "VALIDATION_ERROR", message: [`user ${TAX_ID} over limit`] });
      return json(201, { id: "pay-1", status: "CONSENT_AUTHORIZED", endToEndId: "E44471172202610222049abcdef12345" });
    }
    if (init?.method === "GET" && path === "/sweeping/authorizations/urn%3AIniciador%3Aauth-1/payments/pay-1/status") {
      if (options.paymentStatus) return json(options.paymentStatus, { message: "payment read refused" });
      return json(200, { id: "pay-1", status: "PAYMENT_COMPLETED", endToEndId: "E44471172202610222049abcdef12345" });
    }
    return json(404, { message: "not found" });
  }) as typeof fetch;
  return { fetchImpl, calls, tokens: () => tokens };
}

function httpApi(fake: ReturnType<typeof fakeIniciador>) {
  return new HttpSweepingApi({ baseUrl: BASE, credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, fetch: fake.fetchImpl });
}

describe("the Iniciador client", () => {
  it("authenticates once, reuses the token, and refreshes it once on a 401", async () => {
    const fake = fakeIniciador({ expireTokenOnce: true });
    const api = httpApi(fake);
    await api.createAuthorization({ externalId: "x", taxId: TAX_ID, participantId: "p", creditorId: "c", triggerId: "t", totalAllowedAmount: 1000, transactionLimit: 500 });
    await api.getAuthorization("urn:Iniciador:auth-1");
    expect(fake.tokens()).toBe(2);
    const sent = fake.calls.find((c) => c.method === "POST" && c.path === "/sweeping/authorizations")!.body!;
    expect(sent["configuration"]).toEqual({ totalAllowedAmount: 1000, transactionLimit: 500 });
    expect(sent["triggers"]).toEqual(["t"]);
    expect(sent["creditors"]).toEqual(["c"]);
  });

  it("never puts the client id, the secret, the token or a CPF in an error", async () => {
    const fake = fakeIniciador({ paymentCreate: "422" });
    const api = httpApi(fake);
    await api.getAuthorization("urn:Iniciador:auth-1");
    const err = await api.createPayment("urn:Iniciador:auth-1", { externalId: "e", creditorId: "c", triggerId: "t", amount: 100, description: "d", riskSignals: CONFIG.riskSignals() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IniciadorError);
    const message = (err as Error).message;
    expect(message).toContain("VALIDATION_ERROR");
    for (const secret of [CLIENT_ID, CLIENT_SECRET, TOKEN, TAX_ID]) expect(message).not.toContain(secret);
    expect(scrub(`x ${TOKEN} ${CLIENT_SECRET} ${TAX_ID}`, [CLIENT_SECRET])).toBe("x <token> <secret> *******8909");
  });

  it("refuses a base URL that is not the sandbox or a local mock", () => {
    expect(() => new HttpSweepingApi({ baseUrl: "https://consumer.inic.dev/v1", credentials: { clientId: "a", clientSecret: "b" } })).toThrow(/sandbox/);
    expect(() => new HttpSweepingApi({ credentials: { clientId: "a", clientSecret: "b" } })).not.toThrow();
  });
});

describe("the pull rail", () => {
  it("pay() creates the authorization and answers accepted with the consent link; the looks pay once and settle on the end-to-end id", async () => {
    const fake = fakeIniciador({ authStatus: ["AWAITING_AUTHORISATION", "AUTHORISED"] });
    const rail = new SweepingPullRail(store(), httpApi(fake), CONFIG, true);
    const accepted = await rail.pay(payment());
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;
    expect(accepted.transaction_id).toBe("urn:Iniciador:auth-1");
    expect(accepted.instrument.consent_url).toBe("https://bank.example/consent?request_uri=urn:x");
    expect(accepted.instrument.payable).toBe(true);

    const waiting = await rail.lookup("att_1", payment());
    expect(waiting?.status).toBe("accepted");
    const settled = await rail.lookup("att_1", payment());
    expect(settled).toMatchObject({ status: "settled", transaction_id: "E44471172202610222049abcdef12345", receipt_id: "pay-1", sandbox: true, money_moved: false });
    // A later look answers from the record: no second payment, no second read.
    const before = fake.calls.length;
    expect((await rail.lookup("att_1", payment()))?.status).toBe("settled");
    expect(fake.calls.length).toBe(before);
    expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/payments"))).toHaveLength(1);
    const pull = fake.calls.find((c) => c.path.endsWith("/payments"))!.body!;
    expect(pull).toMatchObject({ amount: 100, creditorId: "creditor-test", triggerId: "trigger-manual", externalId: "att_1-pull" });
    expect((pull["riskSignals"] as { type: string }).type).toBe("MANUAL");

    const receipt = await rail.receipt("pay-1", payment().actor);
    expect(receipt).toMatchObject({ kind: "charge", receipt_sig: null, receipt_sig_ed25519: null, chain: null, payment: { amount_minor: 100, payee: "creditor-test" } });
  });

  it("presenting the same attempt again creates nothing new", async () => {
    const fake = fakeIniciador({ authStatus: ["AWAITING_AUTHORISATION"] });
    const rail = new SweepingPullRail(store(), httpApi(fake), CONFIG, true);
    await rail.pay(payment());
    await rail.pay(payment());
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === "/sweeping/authorizations")).toHaveLength(1);
  });

  it("a payment request whose answer was lost is never sent again: every later look is uncertain", async () => {
    const fake = fakeIniciador({ paymentCreate: "lost" });
    const rail = new SweepingPullRail(store(), httpApi(fake), CONFIG, true);
    await rail.pay(payment());
    expect((await rail.lookup("att_1", payment()))?.status).toBe("uncertain");
    expect((await rail.lookup("att_1", payment()))).toMatchObject({ status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true });
    expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/payments"))).toHaveLength(1);
  });

  it("a clear refusal to read the authorization fails the attempt; a 5xx stays uncertain and is looked at again", async () => {
    const refused = new SweepingPullRail(store(), httpApi(fakeIniciador({ authRead: 404 })), CONFIG, true);
    await refused.pay(payment());
    expect(await refused.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "authorization_unreadable" });

    const flaky = new SweepingPullRail(store(), httpApi(fakeIniciador({ authRead: 503 })), CONFIG, true);
    await flaky.pay(payment());
    const seen = await flaky.lookup("att_1", payment());
    expect(seen).toMatchObject({ status: "uncertain", code: "authorization_unreadable" });
    expect(seen && "needs_human" in seen).toBe(false);
  });

  it("a clear refusal to read a payment already requested stops at a human, never failed: the money may have moved", async () => {
    const fake = fakeIniciador({ paymentStatus: 403 });
    const rail = new SweepingPullRail(store(), httpApi(fake), CONFIG, true);
    await rail.pay(payment());
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "uncertain", code: "payment_unreadable", needs_human: true });
    expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/payments"))).toHaveLength(1);
  });

  it("an expired link fails as charge_expired, a rejected one as charge_cancelled", async () => {
    const expired = new SweepingPullRail(store(), httpApi(fakeIniciador({ authStatus: ["REJECTED"], rejection: "REJEITADO_TEMPO_EXPIRADO_ACCOUNT_HOLDER_VALIDATION" })), CONFIG, true);
    await expired.pay(payment());
    expect(await expired.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "charge_expired" });
    const rejected = new SweepingPullRail(store(), httpApi(fakeIniciador({ authStatus: ["REJECTED"], rejection: "REJEITADO_USUARIO" })), CONFIG, true);
    await rejected.pay(payment());
    expect(await rejected.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "charge_cancelled" });
  });

  it("refuses, before any call, a payee that is not the creditor and an amount above the transaction limit", async () => {
    const fake = fakeIniciador();
    const rail = new SweepingPullRail(store(), httpApi(fake), CONFIG, true);
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
    expect(sweepingLimits({ INICIADOR_TOTAL_CENTS: "2000", INICIADOR_TX_LIMIT_CENTS: "300" })).toEqual({ total_minor: 2000, per_tx_minor: 300 });
    expect(() => sweepingLimits({ INICIADOR_TX_LIMIT_CENTS: "2000" })).toThrow(/cannot exceed/);
    expect(() => sweepingLimits({ INICIADOR_TOTAL_CENTS: "10.5" })).toThrow(/positive integer/);
  });
});
