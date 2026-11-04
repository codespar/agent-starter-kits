/**
 * The JSR rail and its MCP client, offline. The rail is driven over the
 * in-memory fixture and over a scripted API; the client over a fake `fetch`
 * that answers JSON-RPC inside an event stream, as the sandbox did on
 * 2026-10-27. What is tested: the two pages in order (enroll, then sign),
 * the payment asked for once and never again after a lost answer, the
 * bank's outcomes read as the core's reasons, and no secret in an error.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StateStore, type RailPayment } from "@codespar/agent-core";
import { IniciadorError } from "../src/iniciador.js";
import { HttpJsrApi, rpcMessage, type JsrApi, type JsrPaymentView } from "../src/iniciador-mcp.js";
import { DEVICE_CONTEXT, FixtureJsrApi, JsrPullRail, creditorPayeeId, type JsrRailConfig } from "../src/modules/jsr-pull.js";

const tempDirs: string[] = [];
function store(): StateStore {
  const dir = mkdtempSync(join(tmpdir(), "topup-jsr-"));
  tempDirs.push(dir);
  return new StateStore(join(dir, "state.db"));
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const TAX_ID = "12345678909";
const CREDITOR = { name: "Minha conta", taxId: TAX_ID, ispb: "13935893", issuer: "0001", number: "100000001", accountType: "TRAN" };
const PAYEE = creditorPayeeId(CREDITOR);
const CONFIG: JsrRailConfig = { payee: PAYEE, creditor: CREDITOR, participantId: "participant-banco-de-testes", taxId: TAX_ID, userName: "Teste", limits: { total_minor: 1000, per_tx_minor: 500 }, deviceContext: DEVICE_CONTEXT };

function payment(over: Partial<RailPayment> = {}): RailPayment {
  return { attempt_id: "att_1", mandate_id: "pol_topup", amount_minor: 100, currency: "BRL", payee: PAYEE, purpose: "topup", agent_id: "topup-agent", actor: { type: "agent", agent: "topup-agent", on_behalf_of: "usr_demo" }, ...over };
}

describe("the JSR rail on the fixture", () => {
  it("no passkey yet: the enroll page, then the sign page, then settled with the end-to-end id", async () => {
    const s = store();
    const rail = new JsrPullRail(s, new FixtureJsrApi(s), CONFIG, true);
    const first = await rail.pay(payment());
    expect(first).toMatchObject({ status: "accepted", instrument: { consent_step: "enroll", payable: true } });
    expect(first.status === "accepted" && first.instrument.consent_url).toMatch(/^https:\/\//);
    const second = await rail.lookup("att_1", payment());
    expect(second).toMatchObject({ status: "accepted", instrument: { consent_step: "sign" } });
    expect(second && second.status === "accepted" && second.instrument.consent_url).toMatch(/\/agentic\/pay\//);
    const third = await rail.lookup("att_1", payment());
    expect(third).toMatchObject({ status: "settled", sandbox: true, money_moved: false });
    expect(third && third.status === "settled" && third.transaction_id).toMatch(/^E\d{8}/);
    const receipt = await rail.receipt(third && third.status === "settled" ? third.receipt_id! : "", { type: "agent", agent: "topup-agent", on_behalf_of: "usr_demo" });
    expect(receipt).toMatchObject({ state: "paid", receipt_sig_ed25519: null, raw: { rail: "iniciador-jsr" } });
  });

  it("a passkey already registered: straight to the sign page", async () => {
    const s = store();
    const rail = new JsrPullRail(s, new FixtureJsrApi(s, "signs", true), CONFIG, true);
    expect(await rail.pay(payment())).toMatchObject({ status: "accepted", instrument: { consent_step: "sign" } });
  });

  it("alwaysEnroll registers a new passkey even with one on record", async () => {
    const s = store();
    const rail = new JsrPullRail(s, new FixtureJsrApi(s, "signs", true), { ...CONFIG, alwaysEnroll: true }, true);
    expect(await rail.pay(payment())).toMatchObject({ status: "accepted", instrument: { consent_step: "enroll" } });
  });

  it("a payment nobody signed ends charge_expired", async () => {
    const s = store();
    const rail = new JsrPullRail(s, new FixtureJsrApi(s, "lets-expire", true), CONFIG, true);
    await rail.pay(payment());
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "charge_expired" });
  });

  it("refuses a payee that is not the creditor, and an amount above the limit per pull, before any call", async () => {
    const s = store();
    const rail = new JsrPullRail(s, new FixtureJsrApi(s), CONFIG, true);
    expect(await rail.pay(payment({ payee: "someone-else" }))).toMatchObject({ status: "failed", code: "creditor_mismatch" });
    expect(await rail.pay(payment({ attempt_id: "att_2", amount_minor: 501 }))).toMatchObject({ status: "failed", code: "above_transaction_limit" });
  });
});

describe("the payment goes out at most once", () => {
  it("a lost answer to create_payment is uncertain, needs a human, and is never asked again", async () => {
    const s = store();
    let creates = 0;
    const api: JsrApi = {
      completedEnrollment: async () => ({ authorizationId: "enr_1", status: "COMPLETED", upstreamStatus: "AUTHORISED", terminal: true, url: null }),
      createEnrollment: async () => {
        throw new Error("not reached");
      },
      getEnrollment: async () => {
        throw new Error("not reached");
      },
      createPayment: async (): Promise<JsrPaymentView> => {
        creates += 1;
        throw new IniciadorError(0, "network", "MCP create_payment: no answer");
      },
      getPayment: async () => {
        throw new Error("not reached");
      },
    };
    const rail = new JsrPullRail(s, api, CONFIG, true);
    expect(await rail.pay(payment())).toMatchObject({ status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true });
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true });
    expect(await rail.pay(payment())).toMatchObject({ status: "uncertain" });
    expect(creates).toBe(1);
  });
});

const CLIENT_ID = "fake-client-id-123456";
const CLIENT_SECRET = "fake-secret-abcdef-7890";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlLWZha2U";

/** A fake agentic MCP plus the one REST read, behind `fetch`. Tool answers are JSON-RPC inside `text/event-stream`. */
function fakeIniciador(tools: Record<string, (args: Record<string, unknown>) => unknown>, rest: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; method?: string; tool?: string; agentId?: string | null; auth?: string | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/v1/, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }) : null;
    calls.push({ path, ...(body?.method ? { method: body.method } : {}), ...(body?.params?.name ? { tool: body.params.name } : {}), agentId: headers["x-agent-id"] ?? null, auth: headers["authorization"] ?? null });
    if (path === "/agentic/auth" || path === "/enrollments/auth") return new Response(JSON.stringify({ accessToken: TOKEN }), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/agentic/mcp") {
      const result = body?.method === "tools/call" ? { content: [{ type: "text", text: JSON.stringify(tools[body.params!.name!]!(body.params!.arguments ?? {})) }], isError: false } : { protocolVersion: "2024-11-05", serverInfo: { name: "fake" } };
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body?.id, result })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path in rest) return new Response(JSON.stringify(rest[path]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ code: "NOT_FOUND", message: `no route ${path} for ${CLIENT_SECRET}` }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("the MCP client", () => {
  it("initializes once, sends x-agent-id, reads tools out of the event stream, and the end-to-end id from the REST read", async () => {
    const fake = fakeIniciador(
      {
        create_payment: () => ({ url: "https://app.example/agentic/pay/p1?token=x", paymentId: "p1", mode: "redirect", authorizationId: "enr_1" }),
        status_payment: () => ({ status: "COMPLETED", terminal: true, upstreamStatus: "PAYMENT_COMPLETED" }),
      },
      { "/enrollments/payments/p1/status": { id: "p1", status: "PAYMENT_COMPLETED", endToEndId: "E44471172202610271427Uc0cd9af529" } },
    );
    const api = new HttpJsrApi({ baseUrl: "http://127.0.0.1:18790/v1", credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, fetch: fake.fetchImpl });
    const created = await api.createPayment({ externalId: "att_1-pull", participantId: "p", taxId: TAX_ID, userName: "Teste", amount: 100, creditor: CREDITOR, description: "d", agentReason: "r" });
    expect(created).toMatchObject({ paymentId: "p1", status: "PENDING", terminal: false, authorizationId: "enr_1" });
    expect(created.url).toContain("/agentic/pay/p1");
    const done = await api.getPayment("p1");
    expect(done).toMatchObject({ status: "COMPLETED", terminal: true, endToEndId: "E44471172202610271427Uc0cd9af529" });
    expect(fake.calls.filter((c) => c.method === "initialize")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.path === "/agentic/mcp").every((c) => c.agentId === "codespar-topup-agent" && c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(fake.calls.map((c) => c.tool).filter(Boolean)).toEqual(["create_payment", "status_payment"]);
  });

  it("a refusal carries no client id, no secret and no token", async () => {
    const fake = fakeIniciador({ status_payment: () => ({ status: "REJECTED", terminal: true, upstreamStatus: "CONSENT_REJECTED" }) });
    const api = new HttpJsrApi({ baseUrl: "http://127.0.0.1:18790/v1", credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, fetch: fake.fetchImpl });
    const err = await api.getPayment("p1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IniciadorError);
    const text = (err as Error).message;
    for (const secret of [CLIENT_ID, CLIENT_SECRET, TOKEN]) expect(text).not.toContain(secret);
  });

  it("refuses a base URL that is not the sandbox", () => {
    expect(() => new HttpJsrApi({ baseUrl: "https://example.com/v1", credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } })).toThrow(/sandbox/);
  });

  it("picks the answer with its id out of a stream, and ignores what is not JSON", () => {
    const stream = `: keep-alive\n\ndata: not json\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n`;
    expect(rpcMessage(stream, "text/event-stream", 7)).toMatchObject({ result: { ok: true } });
    expect(rpcMessage(stream, "text/event-stream", 8)).toBeUndefined();
  });
});

/** A scripted API: every call not overridden fails the test if it is reached. */
function scripted(over: Partial<JsrApi>): JsrApi & { calls: string[] } {
  const calls: string[] = [];
  const unreached = (name: string) => async () => {
    throw new Error(`${name} not reached`);
  };
  const api = {
    completedEnrollment: unreached("completedEnrollment"),
    createEnrollment: unreached("createEnrollment"),
    getEnrollment: unreached("getEnrollment"),
    createPayment: unreached("createPayment"),
    getPayment: unreached("getPayment"),
    ...over,
  } as JsrApi;
  const counted = Object.fromEntries(
    (Object.keys(api) as Array<keyof JsrApi>).map((k) => [k, (...args: never[]) => (calls.push(k), (api[k] as (...a: never[]) => Promise<unknown>)(...args))]),
  ) as unknown as JsrApi;
  return Object.assign(counted, { calls });
}

const PENDING_ENROLLMENT = { authorizationId: "enr_1", status: "PENDING", upstreamStatus: "AWAITING_ACCOUNT_HOLDER_VALIDATION", terminal: false, url: "https://idp.invalid/authorize?request_uri=enr_1" };

describe("expiry", () => {
  it("an enrollment that ends before COMPLETED is charge_expired, and no payment is ever asked for", async () => {
    const s = store();
    let look = 0;
    const api = scripted({
      completedEnrollment: async () => null,
      createEnrollment: async () => PENDING_ENROLLMENT,
      // First look: still waiting for the passkey; second: the link expired unopened.
      getEnrollment: async () => (++look === 1 ? { ...PENDING_ENROLLMENT, url: null } : { authorizationId: "enr_1", status: "REJECTED", upstreamStatus: "EXPIRED", terminal: true, url: null }),
    });
    const rail = new JsrPullRail(s, api, CONFIG, true);
    expect(await rail.pay(payment())).toMatchObject({ status: "accepted", instrument: { consent_step: "enroll" } });
    // Still pending: the same enroll page again, with the link kept from the create (the status answer has none).
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "accepted", instrument: { consent_step: "enroll", consent_url: PENDING_ENROLLMENT.url } });
    const ended = await rail.lookup("att_1", payment());
    expect(ended).toMatchObject({ status: "failed", code: "charge_expired" });
    expect(ended && ended.status === "failed" && ended.message).toMatch(/REJECTED \(EXPIRED\) before the passkey was registered/);
    // Final: neither a later look nor a re-dispatch reaches the bank again.
    expect(await rail.lookup("att_1", payment())).toEqual(ended);
    expect(await rail.pay(payment())).toEqual(ended);
    expect(api.calls).not.toContain("createPayment");
    expect(api.calls.filter((c) => c === "getEnrollment")).toHaveLength(2);
  });

  it("a signing page left open past its window keeps the sign step until the bank ends it, then charge_expired", async () => {
    const s = store();
    let look = 0;
    const api = scripted({
      completedEnrollment: async () => ({ authorizationId: "enr_1", status: "COMPLETED", upstreamStatus: "AUTHORISED", terminal: true, url: null }),
      createPayment: async () => ({ paymentId: "p1", status: "PENDING", upstreamStatus: "CONSENT_AWAITING_AUTHORIZATION", terminal: false, url: "https://app.invalid/agentic/pay/p1?token=x", authorizationId: "enr_1", endToEndId: null, errorCode: null }),
      getPayment: async () =>
        ++look === 1
          ? { paymentId: "p1", status: "PENDING", upstreamStatus: "CONSENT_AWAITING_AUTHORIZATION", terminal: false, url: null, authorizationId: null, endToEndId: null, errorCode: null }
          : { paymentId: "p1", status: "REJECTED", upstreamStatus: "CONSENT_REJECTED", terminal: true, url: null, authorizationId: null, endToEndId: null, errorCode: "TIMEOUT_CONSENTIMENTO" },
    });
    const rail = new JsrPullRail(s, api, CONFIG, true);
    await rail.pay(payment());
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "accepted", instrument: { consent_step: "sign", consent_url: "https://app.invalid/agentic/pay/p1?token=x" } });
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "failed", code: "charge_expired" });
    expect(api.calls.filter((c) => c === "createPayment")).toHaveLength(1);
  });
});

const ENROLLED = { data: [{ authorizationId: "enr_1", status: "COMPLETED", participantId: CONFIG.participantId, createdAt: "2026-10-27T14:00:00Z" }] };
const CREATED = { url: "https://app.example/agentic/pay/p1?token=x", paymentId: "p1", mode: "redirect", authorizationId: "enr_1" };

/**
 * `fakeIniciador` with a fault injected in front of it: `fault` sees each call
 * (the MCP tool name, or the REST path) and answers a Response or an Error to
 * throw from `fetch`, or undefined to let the fake answer.
 */
function faulty(base: ReturnType<typeof fakeIniciador>, fault: (call: { path: string; tool?: string }) => Response | Error | undefined) {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/v1/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as { params?: { name?: string } }) : null;
    const injected = fault({ path, ...(body?.params?.name ? { tool: body.params.name } : {}) });
    if (injected instanceof Error) throw injected;
    if (injected) return injected;
    return base.fetchImpl(url, init);
  }) as typeof fetch;
  return new HttpJsrApi({ baseUrl: "http://127.0.0.1:18790/v1", credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, fetch: fetchImpl });
}

function expectNoSecret(...texts: Array<string | null | undefined>) {
  for (const text of texts) for (const secret of [CLIENT_ID, CLIENT_SECRET, TOKEN]) expect(text ?? "").not.toContain(secret);
}

const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

describe("a status read that times out", () => {
  it("status_payment times out: uncertain, not final, no human; the next look settles; the payment asked for once", async () => {
    const s = store();
    const base = fakeIniciador(
      { list_authorizations: () => ENROLLED, create_payment: () => CREATED, status_payment: () => ({ status: "COMPLETED", terminal: true, upstreamStatus: "PAYMENT_COMPLETED" }) },
      { "/enrollments/payments/p1/status": { id: "p1", status: "PAYMENT_COMPLETED", endToEndId: "E44471172202610271427Uc0cd9af529" } },
    );
    let statusReads = 0;
    const api = faulty(base, (c) => (c.tool === "status_payment" && ++statusReads === 1 ? timeout() : undefined));
    const rail = new JsrPullRail(s, api, CONFIG, true);
    expect(await rail.pay(payment())).toMatchObject({ status: "accepted", instrument: { consent_step: "sign" } });
    const blip = await rail.lookup("att_1", payment());
    expect(blip).toMatchObject({ status: "uncertain", code: "payment_unreadable" });
    expect(blip && "needs_human" in blip && blip.needs_human).toBeFalsy();
    expect(blip && blip.status === "uncertain" && blip.message).toMatch(/MCP status_payment: no answer \(TimeoutError\)/);
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "settled", transaction_id: "E44471172202610271427Uc0cd9af529" });
    expect(base.calls.filter((c) => c.tool === "create_payment")).toHaveLength(1);
  });

  it("status_authorization times out: uncertain, the enrollment kept; the next look goes on to the sign page", async () => {
    const s = store();
    const base = fakeIniciador({
      list_authorizations: () => ({ data: [] }),
      create_authorization: () => ({ authorizationId: "enr_1", status: "PENDING", terminal: false, url: "https://idp.example/authorize?request_uri=r" }),
      status_authorization: () => ({ status: "COMPLETED", terminal: true, upstreamStatus: "AUTHORISED" }),
      create_payment: () => CREATED,
    });
    let reads = 0;
    const api = faulty(base, (c) => (c.tool === "status_authorization" && ++reads === 1 ? timeout() : undefined));
    const rail = new JsrPullRail(s, api, CONFIG, true);
    expect(await rail.pay(payment())).toMatchObject({ status: "accepted", instrument: { consent_step: "enroll" } });
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "uncertain", code: "enrollment_unreadable" });
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "accepted", instrument: { consent_step: "sign" } });
    expect(base.calls.filter((c) => c.tool === "create_payment")).toHaveLength(1);
  });
});

describe("the MCP down", () => {
  it("before the enrollment: uncertain, nothing on record, no payment, no secret", async () => {
    const s = store();
    const base = fakeIniciador({});
    const api = faulty(base, () => new TypeError(`fetch failed: connect ECONNREFUSED 127.0.0.1:18790 ${CLIENT_SECRET}`));
    const rail = new JsrPullRail(s, api, CONFIG, true);
    const outcome = await rail.pay(payment());
    expect(outcome).toMatchObject({ status: "uncertain", code: "enrollment_unconfirmed" });
    expectNoSecret(outcome.status === "uncertain" ? outcome.message : "");
    // Nothing that moves money was asked: no record, so the next dispatch starts clean.
    expect(await rail.lookup("att_1", payment())).toBeUndefined();
    expect(base.calls).toHaveLength(0);
  });

  it.each([
    ["no answer at all", () => new TypeError(`fetch failed: connect ECONNREFUSED ${CLIENT_SECRET}`)],
    ["a 503 that echoes the credentials", () => new Response(JSON.stringify({ code: "UNAVAILABLE", message: `upstream down for ${CLIENT_ID}/${CLIENT_SECRET} with Bearer ${TOKEN}` }), { status: 503, headers: { "content-type": "application/json" } })],
  ])("at create_payment, %s: uncertain, needs a human, no secret anywhere, never asked again", async (_name, fault) => {
    const s = store();
    const base = fakeIniciador({ list_authorizations: () => ENROLLED, create_payment: () => CREATED });
    let creates = 0;
    const api = faulty(base, (c) => (c.tool === "create_payment" ? (creates++, fault()) : undefined));
    const rail = new JsrPullRail(s, api, CONFIG, true);
    const outcome = await rail.pay(payment());
    expect(outcome).toMatchObject({ status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true });
    expect(await rail.lookup("att_1", payment())).toMatchObject({ status: "uncertain", code: "pull_dispatch_uncertain", needs_human: true });
    expect(await rail.pay(payment())).toMatchObject({ status: "uncertain" });
    expect(creates).toBe(1);
    expectNoSecret(outcome.status === "uncertain" ? outcome.message : "", s.getCursor("jsr:att_1"));
  });
});
