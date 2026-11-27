/**
 * The CodeSpar receivable rail through COLLECT, the public surface the
 * Playground's own charge path uses (CONTRATO v1.6, decision D1 of
 * 27/11/2026). A charge is a Collect link: one link, one charge, one valid
 * payment. Every call is a route of the API's public OpenAPI document, made
 * with the project's `csk_test_` key:
 *
 *   pay()      POST /v1/collect/links            the link, its first draft and the debtor's name (payer prefill),
 *                                                  under `reference` = this attempt (D-C: the same obligation answers
 *                                                  the same link, forever; a retry never makes a second one)
 *              POST /v1/collect/links/{id}/publish  the link in front of payers; refused before anything is shown when
 *                                                  the receiving account cannot receive (`receiving_identity_missing`)
 *   lookup()   GET  /v1/collect/{linkId}           the payer page's read: the current attempt (its Pix copia-e-cola once
 *                                                  `open`) and, once paid, the payment with its Collect receipt (`clr_`).
 *                                                  The read also takes the issuer's due readiness and confirmation reads,
 *                                                  which is what moves an attempt from `issuing` to `open` and to `paid`.
 *              GET  /v1/collect/links?reference=   only when the create's answer was lost: which link this attempt has
 *   receipt()  GET  /v1/collect/links/{id}/payments  the payment, its receipt, and how many payments the link has: a
 *                                                  single-use link credits once (`kind: paid`), anything else is an exception
 *
 * The Test payer (`payCollectLinkAsTestPayer`, below) is the payer page's
 * step followed by Collect's payer button, both public:
 *
 *   POST /v1/collect/{linkId}/attempts             the attempt (the Pix with due date at the provider's sandbox), asked
 *                                                  as the payer, with the payer fields the link did not prefill
 *   POST /v1/collect/attempts/{id}/test-pay        the platform's Test payer pays it: a REAL Pix at the provider's
 *                                                  sandbox, one per charge, Test projects only; no body
 *
 * The same steps the Playground's charge port takes (enterprise
 * playground/kits/charge-proposals.ts): a link whose payer is prefilled with
 * the debtor's name only, an attempt asked on the `page` surface with the
 * Test payer's own document and address, and `payCollectAttemptInTest`. What
 * differs is who asks: here the kit, with the developer's key, instead of a
 * person on the proposal card; and the due date, which the public create
 * takes as `due_in_days` (1 to 60) and not as a date, so a charge due today
 * is due tomorrow (OPEN_QUESTIONS §69).
 *
 * The rail never pays and never marks anything paid: an attempt turns `paid`
 * the way any payment does, and `lookup()` sees it. An unknown answer stays
 * unknown (`uncertain`) and is never re-sent; a Test payment whose answer is
 * lost is never asked again (the route keeps its claim, and a second call
 * answers `test_pay_already_used`).
 */
import type { ApiClient, ApiOperation, ApiRequestBody, ApiSuccess } from "@codespar/sdk";
import type { PaymentRail, RailLookup, RailOutcome, RailPayment, RailReceipt } from "../rail.js";
import type { Actor, ChargeInstrument } from "../types.js";
import { describeApiError, isUncertain, type ApiErrorCode, type ApiFailure } from "./client.js";

type CreateOp = ApiOperation<"/v1/collect/links", "post">;
type PublishOp = ApiOperation<"/v1/collect/links/{linkId}/publish", "post">;
type PageAttemptOp = ApiOperation<"/v1/collect/{linkId}/attempts", "post">;
type TestPayOp = ApiOperation<"/v1/collect/attempts/{attemptId}/test-pay", "post">;
type ListQuery = NonNullable<ApiOperation<"/v1/collect/links", "get">["parameters"]["query"]>;

export type CollectLinkView = ApiSuccess<CreateOp>;
export type CollectPayments = ApiSuccess<ApiOperation<"/v1/collect/links/{linkId}/payments", "get">>;
export type CollectPayment = CollectPayments["data"][number];
export type CollectTestPayment = ApiSuccess<TestPayOp>;

/**
 * The create's body as the route takes it today (enterprise routes/collect.ts, `CollectLinkCreateSchema`): `consumer_id`
 * optional (D-B: omitted, Collect chooses the receiver) and `reference` + `reference_version` (D-C). The SDK pinned here
 * (0.16.16) types the create from before both, so the body is written against the route and handed to the typed call as
 * the SDK's type; the pin bump is its own PR (OPEN_QUESTIONS §69).
 */
type SdkCreateBody = ApiRequestBody<CreateOp>;
export type CollectLinkCreate = Omit<SdkCreateBody, "consumer_id"> & { consumer_id?: string; reference: string; reference_version: string };

const RECEIVER_MISSING: ApiErrorCode<PublishOp> = "receiving_identity_missing";
const ALREADY_PAID: ApiErrorCode<TestPayOp> = "test_pay_already_used";
const ATTEMPT_FAILED: ApiErrorCode<PageAttemptOp> = "collect_attempt_failed";

/** The page read's answer (`GET /v1/collect/{linkId}`), typed by the SDK as an open record: the fields this rail reads. */
export interface CollectPageView {
  id: string;
  environment: "live" | "test";
  state: "draft" | "published" | "paused" | "archived";
  paid: boolean;
  expired: boolean;
  url: string;
  total_minor: number;
  payer_form: Record<string, "required" | "optional" | "off" | "prefilled">;
  attempt: {
    id: string;
    state: "issuing" | "open" | "superseded" | "expired" | "cancelled" | "paid" | "failed";
    amount_minor: number;
    due_date: string;
    copy_paste: string | null;
    retry_after?: number;
    failure_code?: string | null;
  } | null;
  payment: { paid_at: string; amount_minor: number; rail: string; receipt: { id: string } | null } | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads the page view off the open record, field by field; a shape this rail does not know is `undefined`, never guessed. */
export function readPageView(raw: unknown): CollectPageView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw["id"];
  const state = raw["state"];
  const paid = raw["paid"];
  if (typeof id !== "string" || typeof state !== "string" || typeof paid !== "boolean") return undefined;
  const a = raw["attempt"];
  const p = raw["payment"];
  const r = isRecord(p) ? p["receipt"] : undefined;
  const attemptId = isRecord(a) ? a["id"] : undefined;
  const attemptState = isRecord(a) ? a["state"] : undefined;
  const failure = isRecord(a) ? a["failure_code"] : undefined;
  const retry = isRecord(a) ? a["retry_after"] : undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : NaN);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    id,
    environment: raw["environment"] === "live" ? "live" : "test",
    state: state as CollectPageView["state"],
    paid,
    expired: raw["expired"] === true,
    url: str(raw["url"]),
    total_minor: num(raw["total_minor"]),
    payer_form: isRecord(raw["payer_form"]) ? (raw["payer_form"] as CollectPageView["payer_form"]) : {},
    attempt:
      isRecord(a) && typeof attemptId === "string" && typeof attemptState === "string"
        ? {
            id: attemptId,
            state: attemptState as NonNullable<CollectPageView["attempt"]>["state"],
            amount_minor: num(a["amount_minor"]),
            due_date: str(a["due_date"]),
            copy_paste: typeof a["copy_paste"] === "string" ? a["copy_paste"] : null,
            ...(typeof retry === "number" ? { retry_after: retry } : {}),
            ...(typeof failure === "string" ? { failure_code: failure } : {}),
          }
        : null,
    payment:
      isRecord(p) && typeof p["paid_at"] === "string"
        ? { paid_at: p["paid_at"], amount_minor: num(p["amount_minor"]), rail: str(p["rail"]) || "unknown", receipt: isRecord(r) && typeof r["id"] === "string" ? { id: r["id"] } : null }
        : null,
  };
}

/** The obligation's reference on Collect (D-C): this attempt, so the same attempt is the same link. `[A-Za-z0-9:._-]{1,200}`. */
export function collectReference(attemptId: string): string {
  const reference = `kit:${attemptId}`;
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(reference)) throw new Error(`attempt id ${attemptId} cannot be a Collect reference`);
  return reference;
}

/** Days from `today` to `due` (both YYYY-MM-DD), held to the create's 1..60. A charge due today is due in one day. */
export function dueInDays(due: string, today: string): number {
  const days = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  return Math.min(60, Math.max(1, Number.isFinite(days) ? days : 1));
}

/** Today in São Paulo, the calendar Collect counts `due_in_days` on. */
function saoPauloToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * What a page read means for the attempt. The LINK is the obligation: published and unpaid, it is payable by whoever opens its
 * page (the Pix is issued when they do); paid, it is settled with its Collect receipt; withdrawn unpaid, it was cancelled. An
 * attempt that expired, failed or was superseded does not end the link: another attempt can still be paid on it, so the
 * charge stays open until the link is paid or withdrawn.
 */
export function outcomeOfPage(view: CollectPageView): RailOutcome {
  if (view.environment !== "test") return { status: "failed", code: "live_key_refused", message: `link ${view.id} is a live link; this kit charges in test only`, raw: view };
  if (view.paid && view.payment) {
    return { status: "settled", transaction_id: view.id, receipt_id: view.payment.receipt?.id ?? null, money_moved: false, sandbox: true, raw: view };
  }
  if (view.state === "archived") return { status: "failed", code: "charge_cancelled", message: `link ${view.id} was withdrawn unpaid`, raw: view };
  const attempt = view.attempt;
  const open = attempt?.state === "open" && attempt.copy_paste ? attempt.copy_paste : null;
  const instrument: ChargeInstrument = {
    payable: view.state === "published" && !view.expired,
    status: attempt ? `attempt_${attempt.state}${attempt.failure_code ? `:${attempt.failure_code}` : ""}` : `link_${view.state}`,
    pix_copy_paste: open,
    boleto_bank_line: null,
    boleto_bar_code: null,
    due_date: attempt?.due_date || null,
    payment_url: view.url || null,
  };
  return { status: "accepted", transaction_id: view.id, instrument, sandbox: true, raw: view };
}

export interface CollectChargeRailOptions {
  /**
   * The receiving consumer (`consumer_id`). Omitted, Collect chooses it (D-B): the project's default receiver, else its only
   * consumer with a receiving account of its own (in a Test project, the account the platform opened for it).
   */
  receiver?: string | undefined;
  /** Today's date for `due_in_days`; the engine's clock in a pinned run. */
  clock?: () => Date;
}

export class CollectChargeRail implements PaymentRail {
  readonly name = "codespar-collect" as const;
  /** The link of each receipt this rail has seen, so `receipt()` reads the right link's payments. */
  private readonly linkOfReceipt = new Map<string, string>();

  constructor(
    private readonly api: ApiClient,
    private readonly options: CollectChargeRailOptions = {},
  ) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
    if (!payment.due_date) return { status: "failed", code: "due_date_required", message: "a receivable needs a due_date" };
    if (payment.currency !== "BRL") return { status: "failed", code: "invalid_body", message: `a Collect link charges BRL; this charge is in ${payment.currency}` };
    const title = (payment.description ?? payment.purpose).trim().slice(0, 120) || "Cobrança";
    const debtor = (payment.beneficiary ?? payment.payee).trim().slice(0, 140);
    const body: CollectLinkCreate = {
      ...(this.options.receiver ? { consumer_id: this.options.receiver } : {}),
      version: {
        title,
        items: [{ name: title, quantity: 1, unit_amount_minor: payment.amount_minor }],
        surfaces: ["page"],
        due_in_days: dueInDays(payment.due_date, saoPauloToday(this.options.clock ? this.options.clock() : new Date())),
        payer_fields: { contact: "off", external_reference: "off" },
      },
      ...(debtor ? { payer: { name: debtor } } : {}),
      reference: collectReference(payment.attempt_id),
      reference_version: "1",
    };
    let link: CollectLinkView;
    try {
      link = await this.api.post("/v1/collect/links", { body: body as unknown as SdkCreateBody });
    } catch (err) {
      return this.refusal(describeApiError(err));
    }
    if (link.environment !== "test") {
      await this.withdraw(link.id);
      return { status: "failed", code: "live_key_refused", message: `the API created link ${link.id} in ${link.environment}; this kit charges in test only, and the link was withdrawn` };
    }
    const asked = (link.draft ?? link.version)?.total_minor;
    if (asked !== payment.amount_minor) {
      const withdrawn = await this.withdraw(link.id);
      return { status: "failed", code: "amount_mismatch", message: `the API priced link ${link.id} at ${String(asked)} for a request of ${payment.amount_minor}; ${withdrawn ? "withdrawn" : "withdrawal refused, an operator must archive it"}` };
    }
    if (link.state !== "published") {
      try {
        await this.api.post("/v1/collect/links/{linkId}/publish", { path: { linkId: link.id } });
      } catch (err) {
        const failure = describeApiError(err);
        // A refused publish leaves the link a draft: nobody was shown anything, and nothing can be paid.
        if (failure.code === RECEIVER_MISSING) return { status: "failed", code: failure.code, message: `${failure.message}; link ${link.id} stays a draft and nothing was shown to a payer` };
        return this.refusal(failure);
      }
    }
    const page = await this.page(link.id);
    if (page.kind === "view") return this.seen(outcomeOfPage(page.view), page.view.id);
    if (page.kind === "gone") return { status: "failed", code: "charge_cancelled", message: `link ${link.id} was withdrawn before anybody paid it` };
    // Published, and its read did not answer: the link exists and may be paid. Never "not issued".
    return { status: "uncertain", code: page.failure.code, message: `link ${link.id} was published and its read answered ${page.failure.code}: ${page.failure.message}` };
  }

  /** By the link when the create handed it back; by this attempt's reference when it did not. Read-only. */
  async lookup(attemptId: string, _payment: RailPayment, transactionId?: string): Promise<RailLookup> {
    let linkId = transactionId;
    if (!linkId) {
      const found = await this.byReference(attemptId);
      if (found.kind === "failure") return { status: "uncertain", code: found.failure.code, message: found.failure.message };
      if (found.kind === "none") return undefined;
      // A draft was never shown to anybody: nothing is payable. Said, and left to a person; it is never published from a read.
      if (found.link.state === "draft") return { status: "uncertain", code: "issuance_unconfirmed", message: `link ${found.link.id} of attempt ${attemptId} is still a draft: nothing was shown to a payer`, needs_human: true };
      linkId = found.link.id;
    }
    const page = await this.page(linkId);
    if (page.kind === "gone") return { status: "failed", code: "charge_cancelled", message: `link ${linkId} was withdrawn unpaid` };
    if (page.kind === "failure") return isUncertain(page.failure) || page.failure.status === 429 ? { status: "in_flight" } : { status: "uncertain", code: page.failure.code, message: page.failure.message };
    return this.seen(outcomeOfPage(page.view), page.view.id);
  }

  /** A settled outcome's receipt is read off its link's payments: the link is kept for `receipt()`, whichever call saw it paid. */
  private seen(outcome: RailOutcome, linkId: string): RailOutcome {
    if (outcome.status === "settled" && outcome.receipt_id) this.linkOfReceipt.set(outcome.receipt_id, linkId);
    return outcome;
  }

  /** The Collect receipt of a paid link, and the proof it credited once: exactly one `paid` payment on the link. */
  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    const linkId = this.linkOfReceipt.get(receiptId);
    if (!linkId) return undefined;
    let payments: CollectPayments;
    try {
      payments = await this.api.get("/v1/collect/links/{linkId}/payments", { path: { linkId } });
    } catch (err) {
      if (describeApiError(err).status === 404) return undefined;
      throw err;
    }
    const mine = payments.data.find((p) => p.receipt?.id === receiptId);
    if (!mine) return undefined;
    const paid = payments.data.filter((p) => p.kind === "paid");
    const exceptions = payments.data.filter((p) => p.kind === "exception");
    return {
      receipt_id: receiptId,
      kind: "charge",
      // One link, one valid payment: anything beyond it is an exception Collect keeps for a refund or a decision.
      state: paid.length === 1 && exceptions.length === 0 ? "paid" : `paid_with_${paid.length - 1 + exceptions.length}_more_payment(s)`,
      mandate: { id: "n/a" },
      // The link names its payer by name only; the payee of a receivable is the merchant, so none is sealed here.
      payment: { amount_minor: mine.amount_minor, payee: null, attempt_id: mine.attempt_id, money_moved: false, sandbox: true, at: mine.paid_at },
      chain: null,
      receipt_sig: null,
      // The Collect receipt carries its own Ed25519 signature over `codespar-collect-receipt:v1:<id>:<digest>`, a signing string
      // `npm run verify` does not check: it stays in `raw` and is not offered as this kit's verifiable seal (OPEN_QUESTIONS §69).
      receipt_sig_ed25519: null,
      receipt_sig_kid: null,
      actor,
      raw: { payment: mine, credits: { paid: paid.length, exceptions: exceptions.length, ledger_entry_ids: paid.map((p) => p.ledger_entry_id) } },
    };
  }

  private refusal(failure: ApiFailure): RailOutcome {
    if (isUncertain(failure)) return { status: "uncertain", code: failure.code, message: failure.message };
    return { status: "failed", code: failure.code, message: failure.message };
  }

  private async page(linkId: string): Promise<{ kind: "view"; view: CollectPageView } | { kind: "gone" } | { kind: "failure"; failure: ApiFailure }> {
    try {
      const raw = await this.api.get("/v1/collect/{linkId}", { path: { linkId } });
      const view = readPageView(raw);
      return view ? { kind: "view", view } : { kind: "failure", failure: { status: 200, code: "unknown", message: `GET /v1/collect/${linkId} answered a shape this kit does not read` } };
    } catch (err) {
      const failure = describeApiError(err);
      if (failure.status === 410) return { kind: "gone" };
      return { kind: "failure", failure };
    }
  }

  private async byReference(attemptId: string): Promise<{ kind: "link"; link: { id: string; state: string } } | { kind: "none" } | { kind: "failure"; failure: ApiFailure }> {
    try {
      // `reference` filters one obligation (D-C); the SDK pinned here types the list's query from before it (OPEN_QUESTIONS §69).
      const query: ListQuery & { reference: string } = { reference: collectReference(attemptId), limit: 5 };
      const list = await this.api.get("/v1/collect/links", { query });
      const link = list.data[0];
      return link ? { kind: "link", link: { id: link.id, state: link.state } } : { kind: "none" };
    } catch (err) {
      return { kind: "failure", failure: describeApiError(err) };
    }
  }

  private async withdraw(linkId: string): Promise<boolean> {
    try {
      await this.api.post("/v1/collect/links/{linkId}/archive", { path: { linkId } });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Who the platform's Test payer is on the payer page: the fields a link leaves to its payer (the debtor's name is the
 * charger's). The same valid test CPF and address the Playground's charge port sends (charge-proposals.ts, TEST_PAYER_FIELDS).
 */
export const COLLECT_TEST_PAYER_FIELDS = {
  document: "52998224725",
  address: { publicArea: "Rua das Flores", number: "100", neighborhood: "Centro", city: "Recife", state: "PE", postalCode: "50010000" },
} as const;

export interface TestPayerOptions {
  /** How long to wait for the attempt's Pix to exist (`issuing` → `open`), in milliseconds. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type TestPayerResult = { ok: true; attemptId: string; payment: CollectTestPayment } | { ok: false; code: string; message: string };

/**
 * The Test payer pays a link, once: it reads the page, asks the page for its attempt as the payer when there is none to pay,
 * waits for the Pix to exist, and asks Collect's Test payer to pay it. It pays only an attempt that is `open` with a
 * copia-e-cola, which is what a person could have paid; anything else is refused before the pay route is called. The pay
 * route is called at most once and never again on an unknown answer: the route keeps its claim on the charge, and the
 * payment, if it went out, arrives the way any payment does.
 */
export async function payCollectLinkAsTestPayer(api: ApiClient, linkId: string, options: TestPayerOptions = {}): Promise<TestPayerResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.waitMs ?? 180_000);
  const read = async (): Promise<{ ok: true; view: CollectPageView } | { ok: false; failure: ApiFailure }> => {
    try {
      const view = readPageView(await api.get("/v1/collect/{linkId}", { path: { linkId } }));
      return view ? { ok: true, view } : { ok: false, failure: { status: 200, code: "unknown", message: `GET /v1/collect/${linkId} answered a shape this kit does not read` } };
    } catch (err) {
      return { ok: false, failure: describeApiError(err) };
    }
  };

  let page = await read();
  if (!page.ok) return { ok: false, code: page.failure.code, message: page.failure.message };
  if (page.view.environment !== "test") return { ok: false, code: "test_pay_not_permitted", message: `link ${linkId} is not a test link; the Test payer pays nothing there` };
  if (page.view.paid) return { ok: false, code: ALREADY_PAID, message: `link ${linkId} is already paid; nothing was paid` };
  let attempt = page.view.attempt;
  if (!attempt || (attempt.state !== "issuing" && attempt.state !== "open")) {
    // The payer page's step: the payer fields the link did not prefill, under a page session of this link (the same session
    // answers the same attempt).
    const form = page.view.payer_form;
    const asks = (field: string) => form[field] !== "prefilled" && form[field] !== "off";
    const payer = {
      ...(asks("document") ? { document: COLLECT_TEST_PAYER_FIELDS.document } : {}),
      ...(asks("address") ? { address: { ...COLLECT_TEST_PAYER_FIELDS.address } } : {}),
    };
    try {
      const asked = await api.post("/v1/collect/{linkId}/attempts", { path: { linkId }, body: { page_session: `kitpay_${linkId}`, payer, renew: false } });
      attempt = { id: asked.id, state: asked.state, amount_minor: asked.amount_minor, due_date: asked.due_date, copy_paste: asked.copy_paste, ...(asked.retry_after !== undefined ? { retry_after: asked.retry_after } : {}) };
    } catch (err) {
      const failure = describeApiError(err);
      return { ok: false, code: failure.code, message: `${failure.code === ATTEMPT_FAILED ? "the provider's sandbox refused the Pix before it existed" : failure.message}; nothing was paid` };
    }
  }
  while (attempt.state === "issuing" && Date.now() < deadline) {
    await sleep(Math.max(1, Math.min(attempt.retry_after ?? 5, 30)) * 1000);
    page = await read();
    if (!page.ok) {
      if (page.failure.status === 429 || isUncertain(page.failure)) continue;
      return { ok: false, code: page.failure.code, message: `${page.failure.message}; nothing was paid` };
    }
    if (page.view.paid) return { ok: false, code: ALREADY_PAID, message: `link ${linkId} was paid meanwhile; nothing was paid` };
    if (!page.view.attempt || page.view.attempt.id !== attempt.id) return { ok: false, code: "attempt_not_payable", message: `the attempt ${attempt.id} is no longer the link's; nothing was paid` };
    attempt = page.view.attempt;
  }
  if (attempt.state !== "open" || !attempt.copy_paste) {
    return { ok: false, code: attempt.state === "issuing" ? "no_payable_instrument" : "attempt_not_payable", message: `attempt ${attempt.id} is ${attempt.state}${attempt.failure_code ? ` (${attempt.failure_code})` : ""}, with no Pix to pay; the pay route was not called` };
  }
  try {
    const payment = await api.post("/v1/collect/attempts/{attemptId}/test-pay", { path: { attemptId: attempt.id } });
    return { ok: true, attemptId: attempt.id, payment };
  } catch (err) {
    const failure = describeApiError(err);
    // Never asked again: a lost answer may have paid, and the route answers a second call with test_pay_already_used.
    return { ok: false, code: failure.code, message: `${failure.message}${isUncertain(failure) ? "; the answer is unknown and the Test payer does not ask again: the next look says whether it paid" : "; nothing was paid"}` };
  }
}
