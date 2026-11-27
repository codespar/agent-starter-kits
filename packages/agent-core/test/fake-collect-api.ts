/**
 * A local HTTP server that answers Collect's public routes with the shapes the
 * API documents (enterprise `openapi/collect.ts`, `routes/collect.ts`,
 * `routes/collect-public.ts`, `collect/public-view.ts`), so the kit's Collect
 * rail runs over real HTTP through the SDK's client. It is a fixture, not
 * Collect: it keeps the rules the rail depends on and nothing else.
 *
 *   - `reference` + `reference_version` answer the same link forever (200, `replay: true`); other content under the same pair
 *     is 409 `collect_reference_conflict`.
 *   - Owner routes need a `csk_test_` bearer; the payer page's routes need none.
 *   - The payer page's POST is strict (`page_session`, `payer`, `renew`), refuses a field the link prefilled
 *     (`collect_payer_field_prefilled`) and asks for document and address (`collect_payer_fields_missing`); the same page
 *     session answers the same attempt.
 *   - An attempt is `issuing` until the page read takes `issuingReads` reads, then `open` with a copia-e-cola.
 *   - The Test payer pays an `open` attempt once, takes no body, and keeps its claim on a failure: a second call is 409
 *     `test_pay_already_used` whatever happened to the first. The payment lands at the next page read (the confirmation read).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeCollectOptions {
  /** Page reads before an issuing attempt is open. */
  issuingReads?: number;
  /** The publish answers 422 `receiving_identity_missing`. */
  receiverMissing?: boolean;
  /** The create prices the link at this total instead of the items' (an API that understood another amount). */
  misprice?: number;
  /** The create answers 500 this many times before it works (and still creates the link: an answer lost after the write). */
  createFailsAfterWrite?: number;
  /** The page attempt answers 422 `collect_attempt_failed`. */
  attemptFails?: boolean;
  /** The Test payer answers this 502 code, and keeps its claim. */
  testPayFails?: string;
  /** The link's environment. */
  environment?: "test" | "live";
}

interface Link {
  id: string;
  state: "draft" | "published" | "paused" | "archived";
  consumer_id: string;
  reference: string | null;
  reference_version: string | null;
  content: string;
  title: string;
  total_minor: number;
  due_in_days: number;
  prefilled: string[];
  created_at: string;
}

interface Attempt {
  id: string;
  link_id: string;
  page_session: string;
  state: "issuing" | "open" | "paid" | "failed";
  reads: number;
  amount_minor: number;
  due_date: string;
  claimed: boolean;
  paid_pending: boolean;
}

export interface FakeCall {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

export interface FakeCollect {
  url: string;
  calls: FakeCall[];
  links: Map<string, Link>;
  payments: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

const err = (res: ServerResponse, status: number, code: string, message: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message }, request_id: null }));
};
const ok = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function startFakeCollect(options: FakeCollectOptions = {}): Promise<FakeCollect> {
  const links = new Map<string, Link>();
  const attempts = new Map<string, Attempt>();
  const payments: Array<Record<string, unknown>> = [];
  const calls: FakeCall[] = [];
  let seq = 0;
  let createFailures = options.createFailsAfterWrite ?? 0;
  const id = (prefix: string) => `${prefix}${String(++seq).padStart(22, "x")}`;
  const now = () => new Date("2026-11-27T15:00:00.000Z").toISOString();
  const environment = options.environment ?? "test";
  let base = "";

  const versionOf = (l: Link) => ({
    version: 1,
    status: l.state === "draft" ? "draft" : "published",
    title: l.title,
    description: null,
    success_message: null,
    items: [{ name: l.title, quantity: 1, unit_amount_minor: l.total_minor }],
    total_minor: l.total_minor,
    currency: "BRL",
    brand: {},
    surfaces: ["page"],
    due_in_days: l.due_in_days,
    due_on: null,
    payer_fields: { name: "required", contact: "off", external_reference: "off" },
    usdc_price: null,
    usdc_price_atomic: null,
    usdc_price_confirmed_at: null,
    created_at: l.created_at,
    published_at: l.state === "draft" ? null : now(),
  });
  const linkView = (l: Link) => ({
    id: l.id,
    object: "collect_link",
    state: l.state,
    environment,
    consumer_id: l.consumer_id,
    receiver: { name: "Loja Teste" },
    paid: payments.some((p) => p["link_id"] === l.id && p["kind"] === "paid"),
    paid_at: null,
    current_version: l.state === "draft" ? null : 1,
    valid_until: null,
    url: `${base}/c/${l.id}`,
    payer_prefilled: l.prefilled,
    payer_document_masked: null,
    version: l.state === "draft" ? null : versionOf(l),
    draft: l.state === "draft" ? versionOf(l) : null,
    created_at: l.created_at,
    updated_at: l.created_at,
    published_at: l.state === "draft" ? null : now(),
    paused_at: null,
    archived_at: l.state === "archived" ? now() : null,
    reference: l.reference,
    reference_version: l.reference_version,
    receiver_resolution: l.consumer_id === "csm_project_account" ? "only_eligible" : "explicit",
  });
  const attemptView = (a: Attempt) => ({
    id: a.id,
    state: a.state,
    surface: "page",
    amount_minor: a.amount_minor,
    currency: "BRL",
    due_date: a.due_date,
    expires_at: "2026-11-29T02:59:59.000Z",
    copy_paste: a.state === "open" ? `00020101021226990014br.gov.bcb.pix${a.id}5204000053039865802BR6304ABCD` : null,
    ready_at: a.state === "issuing" ? null : now(),
    ...(a.state === "issuing" ? { retry_after: 1 } : {}),
  });
  const currentOf = (linkId: string) => [...attempts.values()].filter((a) => a.link_id === linkId).at(-1) ?? null;
  const paymentOf = (linkId: string) => payments.find((p) => p["link_id"] === linkId && p["kind"] === "paid") ?? null;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const auth = req.headers.authorization ?? null;
    calls.push({ method: req.method ?? "", path: `${url.pathname}${url.search}`, auth, body });
    const parts = url.pathname.split("/").filter(Boolean); // v1, collect, ...
    const [p0 = "", p1 = "", p2 = "", p3 = "", p4 = ""] = parts;
    const owner = () => {
      if (!auth?.startsWith("Bearer csk_test_")) {
        err(res, 401, "unauthorized", "a test key is required");
        return false;
      }
      return true;
    };

    // POST /v1/collect/links
    if (req.method === "POST" && url.pathname === "/v1/collect/links") {
      if (!owner()) return;
      const b = body as Record<string, unknown>;
      const allowed = new Set(["consumer_id", "valid_until", "billing", "version", "payer", "reference", "reference_version"]);
      if (!b || Object.keys(b).some((k) => !allowed.has(k))) return err(res, 400, "invalid_body", "unknown key");
      if ((b["reference"] === undefined) !== (b["reference_version"] === undefined)) return err(res, 400, "invalid_body", "name reference and reference_version together, or neither");
      const v = b["version"] as { title: string; items: Array<{ unit_amount_minor: number; quantity: number }>; surfaces: string[]; due_in_days: number };
      if (!v || typeof v.title !== "string" || !Array.isArray(v.items) || !Number.isInteger(v.due_in_days) || v.due_in_days < 1 || v.due_in_days > 60) return err(res, 400, "invalid_body", "version");
      const total = v.items.reduce((s, i) => s + i.unit_amount_minor * i.quantity, 0);
      if (total < 500) return err(res, 400, "collect_total_below_minimum", "below R$5.00");
      const content = JSON.stringify({ consumer_id: b["consumer_id"] ?? null, version: v, payer: b["payer"] ?? null });
      const reference = typeof b["reference"] === "string" ? b["reference"] : null;
      const existing = reference ? [...links.values()].find((l) => l.reference === reference && l.reference_version === b["reference_version"]) : undefined;
      if (existing) {
        if (existing.content !== content) return err(res, 409, "collect_reference_conflict", "the same reference with different content");
        return ok(res, 200, { ...linkView(existing), replay: true });
      }
      const payer = (b["payer"] ?? {}) as Record<string, unknown>;
      const link: Link = {
        id: id("cl_"),
        state: "draft",
        consumer_id: typeof b["consumer_id"] === "string" ? b["consumer_id"] : "csm_project_account",
        reference,
        reference_version: typeof b["reference_version"] === "string" ? b["reference_version"] : null,
        content,
        title: v.title,
        total_minor: options.misprice ?? total,
        due_in_days: v.due_in_days,
        prefilled: Object.keys(payer),
        created_at: now(),
      };
      links.set(link.id, link);
      if (createFailures > 0) {
        createFailures -= 1;
        return err(res, 500, "internal_error", "the answer was lost after the write");
      }
      return ok(res, 201, { ...linkView(link), replay: false });
    }
    // GET /v1/collect/links?reference=
    if (req.method === "GET" && url.pathname === "/v1/collect/links") {
      if (!owner()) return;
      const reference = url.searchParams.get("reference");
      const data = [...links.values()].filter((l) => reference === null || l.reference === reference).map(linkView);
      return ok(res, 200, { data, next_cursor: null });
    }
    // /v1/collect/links/{id}/{publish|archive|payments}
    if (p0 === "v1" && p1 === "collect" && p2 === "links" && p3 && p4) {
      if (!owner()) return;
      const link = links.get(p3);
      if (!link) return err(res, 404, "not_found", "no collect link with that id in this project");
      if (req.method === "POST" && p4 === "publish") {
        if (options.receiverMissing) return err(res, 422, "receiving_identity_missing", "the receiving consumer cannot receive a Pix with due date in test");
        const changed = link.state === "draft";
        link.state = "published";
        return ok(res, 200, { ...linkView(link), changed });
      }
      if (req.method === "POST" && p4 === "archive") {
        const changed = link.state !== "archived";
        link.state = "archived";
        return ok(res, 200, { ...linkView(link), changed });
      }
      if (req.method === "GET" && p4 === "payments") return ok(res, 200, { data: payments.filter((p) => p["link_id"] === link.id) });
    }
    // POST /v1/collect/attempts/{id}/test-pay
    if (req.method === "POST" && p2 === "attempts" && p4 === "test-pay") {
      if (!owner()) return;
      if (body !== undefined && body !== null && Object.keys(body as object).length > 0) return err(res, 400, "invalid_body", "this operation takes no body");
      const attempt = attempts.get(p3);
      if (!attempt) return err(res, 404, "not_found", "no attempt with that id in this project");
      if (attempt.claimed) return err(res, 409, "test_pay_already_used", "this charge already had its Test payment");
      if (attempt.state !== "open") return err(res, 409, "attempt_not_payable", `the attempt is ${attempt.state}`);
      attempt.claimed = true;
      if (options.testPayFails) return err(res, 502, options.testPayFails, "a step at the provider's sandbox failed; the charge keeps its claim");
      attempt.paid_pending = true;
      return ok(res, 200, { object: "collect_test_payment", attempt_id: attempt.id, charge_id: `chg_${attempt.id}`, amount_minor: attempt.amount_minor, status: "PROCESSING", end_to_end_id: "E00000000202611271500ABCDEFGHIJK" });
    }
    // GET /v1/collect/{linkId} and POST /v1/collect/{linkId}/attempts (the payer page; no credential)
    if (p0 === "v1" && p1 === "collect" && p2.startsWith("cl_")) {
      const link = links.get(p2);
      if (!link || link.state === "draft") return err(res, 404, "not_found", "no collect link with that id");
      if (req.method === "GET" && parts.length === 3) {
        const current = currentOf(link.id);
        if (current?.state === "issuing" && ++current.reads >= (options.issuingReads ?? 1)) current.state = "open";
        if (current?.state === "open" && current.paid_pending) {
          current.state = "paid";
          current.paid_pending = false;
          const pid = id("clp_");
          payments.push({
            id: pid, object: "collect_payment", kind: "paid", exception: null, link_id: link.id, attempt_id: current.id, surface: "page", version: 1,
            charge_id: `chg_${current.id}`, amount_minor: current.amount_minor, currency: "BRL", paid_at: now(), rail: "pix", end_to_end_id: "E00000000202611271500ABCDEFGHIJK",
            ledger_entry_id: id("led_"), simulated: false,
            receipt: { id: id("clr_"), object: "collect_receipt", document: { v: 1, receipt_id: "", issuer: "codespar", charge_id: `chg_${current.id}`, link_id: link.id, link_version: 1, amount_minor: current.amount_minor, currency: "BRL", paid_at: now(), rail: "pix", end_to_end_id: null, ledger_entry_id: "" }, digest: "0".repeat(64), sig: "sig", kid: "kid_1", recipe: {} },
          });
        }
        const paid = paymentOf(link.id);
        if (link.state === "archived" && !paid) return err(res, 410, "collect_link_archived", "this link was withdrawn by its owner");
        const form = Object.fromEntries(["name", "contact", "external_reference", "document", "address"].map((f) => [f, link.prefilled.includes(f) ? "prefilled" : f === "contact" || f === "external_reference" ? "off" : "required"]));
        const now2 = currentOf(link.id);
        return ok(res, 200, {
          id: link.id, object: "collect_page", billing: "one_time", environment, state: link.state, paid: paid !== null, expired: false, url: `${base}/c/${link.id}`,
          receiver: { name: "Loja Teste" }, title: link.title, description: null, items: versionOf(link).items, total_minor: link.total_minor, currency: "BRL", brand: {}, surfaces: ["page"],
          due_in_days: link.due_in_days, due_on: null, valid_until: null, payer_form: form, attempt: now2 ? attemptView(now2) : null,
          payment: paid ? { paid_at: paid["paid_at"], amount_minor: paid["amount_minor"], rail: paid["rail"], receipt: paid["receipt"] } : null,
          success_message: null,
        });
      }
      if (req.method === "POST" && p3 === "attempts") {
        const b = body as Record<string, unknown>;
        const session = b?.["page_session"];
        if (!b || Object.keys(b).some((k) => !["page_session", "payer", "renew"].includes(k)) || typeof session !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(session)) return err(res, 400, "invalid_body", "request body did not match the expected schema");
        const payer = (b["payer"] ?? {}) as Record<string, unknown>;
        const prefilled = Object.keys(payer).filter((f) => link.prefilled.includes(f));
        if (prefilled.length > 0) return err(res, 400, "collect_payer_field_prefilled", `prefilled: ${prefilled.join(", ")}`);
        const missing = ["document", "address"].filter((f) => !link.prefilled.includes(f) && payer[f] === undefined);
        if (missing.length > 0) return err(res, 400, "collect_payer_fields_missing", `missing: ${missing.join(", ")}`);
        const same = [...attempts.values()].find((a) => a.link_id === link.id && a.page_session === session);
        if (same) return ok(res, 200, { ...attemptView(same), replay: true });
        if (options.attemptFails) return err(res, 422, "collect_attempt_failed", "the issuer refused the charge before it existed");
        const attempt: Attempt = { id: id("cla_"), link_id: link.id, page_session: session, state: "issuing", reads: 0, amount_minor: link.total_minor, due_date: "2026-11-28", claimed: false, paid_pending: false };
        attempts.set(attempt.id, attempt);
        return ok(res, 201, { ...attemptView(attempt), replay: false });
      }
    }
    err(res, 404, "not_found", `no route ${req.method} ${url.pathname}`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => err(res, 500, "internal_error", e instanceof Error ? e.message : String(e)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    calls,
    links,
    payments,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
