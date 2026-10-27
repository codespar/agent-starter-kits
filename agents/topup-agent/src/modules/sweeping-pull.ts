/**
 * Module `sweeping-pull`: the rail that pulls money from the person's own bank
 * account into their own account at CodeSpar's partner, through Iniciador's
 * Open Finance sweeping. The core sees it as a receivable: `pay()` creates the
 * bank authorization and answers `accepted` with the consent link as the
 * instrument; every later `lookup()` reads the authorization and, once the
 * person approved it at the bank, makes the ONE payment the approved execution
 * covers and reads it until it completes.
 *
 * One attempt, two calls on the wire, and only the first is made by `pay()`.
 * The second (the payment) is made by the look that first sees AUTHORISED, and
 * it is made at most once: a marker is written to state.db BEFORE the request
 * goes out, so a crash or a lost answer leaves a marker without a payment id,
 * which every later look reports as uncertain instead of paying again. A human
 * reconciles it at the bank; nothing here retries a payment blind.
 *
 * Nothing in this file decides money. The amount, the payee (the creditor id)
 * and the caps were checked by `ExecutionEngine` before `pay()` was called; the
 * rail refuses a payee that is not the configured creditor all the same.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, type Actor, type ChargeInstrument, type PaymentRail, type RailLookup, type RailOutcome, type RailPayment, type RailReceipt, type StateStore } from "@codespar/agent-core";
import { AUTHORIZATION_TERMINAL, IniciadorError, PAYMENT_TERMINAL, type AuthorizationRequest, type AuthorizationView, type PaymentRequest, type PaymentView, type RiskSignals, type SweepingApi } from "../iniciador.js";

export interface SweepingLimits {
  /** `configuration.totalAllowedAmount` and the mandate's `cap_minor`. */
  total_minor: number;
  /** `configuration.transactionLimit` and the mandate's `per_tx_cap_minor`. */
  per_tx_minor: number;
}

export const DEFAULT_LIMITS: SweepingLimits = { total_minor: 1000, per_tx_minor: 500 };

/**
 * The two limits, read once from the environment, for BOTH the bank
 * authorization and the mandate. One function so they cannot drift apart.
 */
export function sweepingLimits(env: NodeJS.ProcessEnv): SweepingLimits {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer in centavos, got ${raw}`);
    return n;
  };
  const limits = { total_minor: read("INICIADOR_TOTAL_CENTS", DEFAULT_LIMITS.total_minor), per_tx_minor: read("INICIADOR_TX_LIMIT_CENTS", DEFAULT_LIMITS.per_tx_minor) };
  if (limits.per_tx_minor > limits.total_minor) throw new Error("INICIADOR_TX_LIMIT_CENTS cannot exceed INICIADOR_TOTAL_CENTS");
  return limits;
}

export interface SweepingRailConfig {
  creditorId: string;
  triggerId: string;
  participantId: string;
  /** The person's CPF: the authorization's `user.taxId`. Never logged, never in a message. */
  taxId: string;
  limits: SweepingLimits;
  riskSignals: () => RiskSignals;
  redirectURL?: string | undefined;
  clock?: () => Date;
}

/** What the rail remembers per attempt, in state.db. Ids and statuses only. */
interface PullRecord {
  authorization_id: string;
  auth_url: string | null;
  amount_minor: number;
  payee: string;
  mandate_id: string;
  created_at: string;
  /** Written BEFORE the payment request goes out; `id` once it answered. */
  payment?: { requested_at: string; id?: string; end_to_end_id?: string | null };
  final?: RailOutcome;
}

const RECORD = (attemptId: string) => `sweeping:${attemptId}`;
const RECEIPT = (paymentId: string) => `sweeping-receipt:${paymentId}`;

export class SweepingPullRail implements PaymentRail {
  readonly name = "iniciador-sweeping" as const;
  private readonly clock: () => Date;

  constructor(
    private readonly store: StateStore,
    private readonly api: SweepingApi,
    private readonly config: SweepingRailConfig,
    private readonly sandbox: boolean,
  ) {
    this.clock = config.clock ?? (() => new Date());
  }

  async pay(payment: RailPayment): Promise<RailOutcome> {
    const existing = this.load(payment.attempt_id);
    if (existing) return existing.final ?? this.awaiting(existing, existing.payment ? "PAYMENT_PENDING" : "AWAITING_AUTHORISATION");
    if (payment.payee !== this.config.creditorId) {
      return { status: "failed", code: "creditor_mismatch", message: "the payee is not the creditor this agent is configured for; nothing was sent" };
    }
    if (payment.amount_minor > this.config.limits.per_tx_minor) {
      return { status: "failed", code: "above_transaction_limit", message: `amount above the authorization's transaction limit (${this.config.limits.per_tx_minor}); nothing was sent` };
    }
    const request: AuthorizationRequest = {
      externalId: payment.attempt_id,
      taxId: this.config.taxId,
      participantId: this.config.participantId,
      creditorId: this.config.creditorId,
      triggerId: this.config.triggerId,
      totalAllowedAmount: this.config.limits.total_minor,
      transactionLimit: this.config.limits.per_tx_minor,
      redirectURL: this.config.redirectURL,
    };
    let auth: AuthorizationView;
    try {
      auth = await this.api.createAuthorization(request);
    } catch (e) {
      return failure(e, "authorization");
    }
    const record: PullRecord = {
      authorization_id: auth.authorizationId,
      auth_url: auth.authUrl,
      amount_minor: payment.amount_minor,
      payee: payment.payee,
      mandate_id: payment.mandate_id,
      created_at: this.clock().toISOString(),
    };
    this.save(payment.attempt_id, record);
    return this.awaiting(record, auth.status);
  }

  async lookup(attemptId: string, payment: RailPayment): Promise<RailLookup> {
    const record = this.load(attemptId);
    if (!record) return undefined;
    if (record.final) return record.final;

    if (!record.payment) {
      let auth: AuthorizationView;
      try {
        auth = await this.api.getAuthorization(record.authorization_id);
      } catch (e) {
        return { status: "uncertain", code: "authorization_unreadable", message: messageOf(e) };
      }
      if (!AUTHORIZATION_TERMINAL.has(auth.status)) return this.awaiting(record, auth.status);
      if (auth.status !== "AUTHORISED") return this.finish(attemptId, record, authorizationFailure(auth));
      // The person approved at the bank. The marker goes to disk before the request does.
      record.payment = { requested_at: this.clock().toISOString() };
      this.save(attemptId, record);
      const request: PaymentRequest = {
        externalId: `${attemptId}-pull`,
        creditorId: this.config.creditorId,
        triggerId: this.config.triggerId,
        amount: record.amount_minor,
        description: payment.description ?? "CodeSpar topup-agent",
        riskSignals: this.config.riskSignals(),
      };
      let created: PaymentView;
      try {
        created = await this.api.createPayment(record.authorization_id, request);
      } catch (e) {
        if (e instanceof IniciadorError && !e.uncertain) return this.finish(attemptId, record, { status: "failed", code: "charge_issuer_error", message: messageOf(e) });
        return { status: "uncertain", code: "pull_dispatch_uncertain", message: `the payment request got no clear answer (${messageOf(e)}); it is NOT retried: check the authorization at the bank` };
      }
      record.payment = { ...record.payment, id: created.id, end_to_end_id: created.endToEndId };
      this.save(attemptId, record);
    }

    const paymentId = record.payment.id;
    if (!paymentId) {
      return { status: "uncertain", code: "pull_dispatch_uncertain", message: "a payment request went out and its answer was lost; it is NOT retried: check the authorization at the bank" };
    }
    let seen: PaymentView;
    try {
      seen = await this.api.getPaymentStatus(record.authorization_id, paymentId);
    } catch (e) {
      return { status: "uncertain", code: "payment_unreadable", message: messageOf(e) };
    }
    const endToEndId = seen.endToEndId ?? record.payment.end_to_end_id ?? null;
    if (!PAYMENT_TERMINAL.has(seen.status)) return this.awaiting(record, seen.status);
    if (seen.status !== "PAYMENT_COMPLETED") return this.finish(attemptId, record, { status: "failed", code: "charge_issuer_error", message: `the bank ended the pull ${seen.status}` });
    const settled: RailOutcome = {
      status: "settled",
      // The Pix end-to-end id is what the person and their bank can look up; the payment id is Iniciador's.
      transaction_id: endToEndId ?? paymentId,
      receipt_id: paymentId,
      money_moved: !this.sandbox,
      sandbox: this.sandbox,
      raw: { authorization_id: record.authorization_id, payment_id: paymentId, end_to_end_id: endToEndId, status: seen.status, completed_seen_at: this.clock().toISOString() },
    };
    this.store.setCursor(RECEIPT(paymentId), attemptId);
    return this.finish(attemptId, { ...record, payment: { ...record.payment, end_to_end_id: endToEndId } }, settled);
  }

  /**
   * The local record of a completed pull. Not a CodeSpar receipt: no chain, no
   * HMAC, no Ed25519 signature. What a third party can check about this pull
   * is the Pix end-to-end id, at the banks, and nothing here.
   */
  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    const attemptId = this.store.getCursor(RECEIPT(receiptId));
    const record = attemptId ? this.load(attemptId) : undefined;
    if (!attemptId || !record || record.final?.status !== "settled") return undefined;
    const raw = record.final.raw as { end_to_end_id?: string | null; completed_seen_at?: string };
    return {
      receipt_id: receiptId,
      kind: "charge",
      state: "paid",
      mandate: { id: record.mandate_id },
      payment: { amount_minor: record.amount_minor, payee: record.payee, attempt_id: attemptId, money_moved: !this.sandbox, sandbox: this.sandbox, at: raw.completed_seen_at ?? record.created_at },
      chain: null,
      receipt_sig: null,
      receipt_sig_ed25519: null,
      receipt_sig_kid: null,
      actor,
      raw: { rail: this.name, authorization_id: record.authorization_id, payment_id: receiptId, end_to_end_id: raw.end_to_end_id ?? null },
    };
  }

  private awaiting(record: PullRecord, status: string): Extract<RailOutcome, { status: "accepted" }> {
    const instrument: ChargeInstrument = {
      payable: true,
      status,
      pix_copy_paste: null,
      boleto_bank_line: null,
      boleto_bar_code: null,
      due_date: null,
      // Only while the bank is waiting for the person; once a payment exists there is nothing left to open.
      consent_url: record.payment ? null : record.auth_url,
    };
    return { status: "accepted", transaction_id: record.authorization_id, instrument, sandbox: this.sandbox, raw: { authorization_id: record.authorization_id, status } };
  }

  private finish(attemptId: string, record: PullRecord, outcome: RailOutcome): RailOutcome {
    this.save(attemptId, { ...record, final: outcome });
    return outcome;
  }

  private load(attemptId: string): PullRecord | undefined {
    const raw = this.store.getCursor(RECORD(attemptId));
    return raw ? (JSON.parse(raw) as PullRecord) : undefined;
  }

  private save(attemptId: string, record: PullRecord): void {
    this.store.setCursor(RECORD(attemptId), JSON.stringify(record));
  }
}

function messageOf(e: unknown): string {
  return e instanceof IniciadorError ? e.message : "unexpected error reading the bank";
}

function failure(e: unknown, what: string): RailOutcome {
  if (e instanceof IniciadorError && !e.uncertain) return { status: "failed", code: "charge_issuer_error", message: `the ${what} was refused: ${e.message}` };
  return { status: "uncertain", code: "authorization_unconfirmed", message: `the ${what} got no clear answer: ${messageOf(e)}` };
}

/** A terminal authorization that is not AUTHORISED, as the core's reasons read it. */
function authorizationFailure(auth: AuthorizationView): RailOutcome {
  const expired = auth.status === "EXPIRED" || (auth.rejection ?? "").includes("TEMPO_EXPIRADO");
  if (expired) return { status: "failed", code: "charge_expired", message: `the consent link was not approved in time (${auth.rejection ?? auth.status})` };
  if (auth.status === "ERROR") return { status: "failed", code: "charge_issuer_error", message: "the bank ended the authorization in ERROR" };
  return { status: "failed", code: "charge_cancelled", message: `the authorization ended ${auth.status}${auth.rejection ? ` (${auth.rejection})` : ""}` };
}

/** MANUAL riskSignals with a device id kept in the agent's state directory (gitignored): the issuer correlates by device. */
export function manualRiskSignals(stateDir: string): () => RiskSignals {
  return () => {
    const file = join(stateDir, "iniciador-device-id");
    let deviceId: string;
    if (existsSync(file)) deviceId = readFileSync(file, "utf8").trim();
    else {
      mkdirSync(stateDir, { recursive: true });
      deviceId = randomBytes(8).toString("hex");
      writeFileSync(file, `${deviceId}\n`, { mode: 0o600 });
    }
    return { type: "MANUAL", deviceId, osVersion: "6.8.0", userTimeZoneOffset: "-03", language: "pt", screenDimensions: { height: 1080, width: 1920 }, accountTenure: "2026-10-21" };
  };
}

export type FixtureFate = "approves" | "expires" | "rejects" | "never";

interface FixtureAuth {
  status: string;
  looks: number;
  fate: FixtureFate;
  rejection: string | null;
}

/**
 * The offline Iniciador: the same four calls, state in state.db, no network.
 * The person's decision at the bank is the fate: approve at the first look
 * (default), let the link expire, reject it, or never act. A payment completes
 * at its first read, as the sandbox's did (3 s after create on 2026-10-22).
 */
export class FixtureSweepingApi implements SweepingApi {
  constructor(
    private readonly store: StateStore,
    private fate: FixtureFate = "approves",
  ) {}

  setFate(fate: FixtureFate): void {
    this.fate = fate;
  }

  /** The person acts on ONE authorization (the scenario payer, a test). */
  decide(authorizationId: string, fate: FixtureFate): void {
    const auth = this.auth(authorizationId);
    if (auth) this.saveAuth(authorizationId, { ...auth, fate });
  }

  async createAuthorization(r: AuthorizationRequest): Promise<AuthorizationView> {
    const id = `urn:fixture:${sha256Hex(r.externalId).slice(0, 16)}`;
    if (!this.auth(id)) this.saveAuth(id, { status: "AWAITING_AUTHORISATION", looks: 0, fate: this.fate, rejection: null });
    return { authorizationId: id, status: "AWAITING_AUTHORISATION", authUrl: `https://banco-de-testes.invalid/consent?request_uri=${encodeURIComponent(id)}`, rejection: null };
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationView> {
    const auth = this.auth(authorizationId);
    if (!auth) throw new IniciadorError(404, "NOT_FOUND", "fixture: no such authorization");
    let next = { ...auth, looks: auth.looks + 1 };
    if (auth.status === "AWAITING_AUTHORISATION") {
      if (auth.fate === "approves") next = { ...next, status: "AUTHORISED" };
      else if (auth.fate === "expires") next = { ...next, status: "REJECTED", rejection: "REJEITADO_TEMPO_EXPIRADO_ACCOUNT_HOLDER_VALIDATION" };
      else if (auth.fate === "rejects") next = { ...next, status: "REJECTED", rejection: "REJEITADO_USUARIO" };
    }
    this.saveAuth(authorizationId, next);
    return { authorizationId, status: next.status, authUrl: null, rejection: next.rejection };
  }

  async createPayment(authorizationId: string, r: PaymentRequest): Promise<PaymentView> {
    const auth = this.auth(authorizationId);
    if (auth?.status !== "AUTHORISED") throw new IniciadorError(422, "AUTHORIZATION_NOT_AUTHORISED", "fixture: the authorization is not AUTHORISED");
    const id = `pay_fixture_${sha256Hex(r.externalId).slice(0, 12)}`;
    const e2e = `E00000000${sha256Hex(id).slice(0, 23).toUpperCase()}`;
    this.store.setCursor(`sweeping-fixture:pay:${id}`, JSON.stringify({ status: "CONSENT_AUTHORIZED", endToEndId: e2e }));
    return { id, status: "CONSENT_AUTHORIZED", endToEndId: e2e };
  }

  async getPaymentStatus(_authorizationId: string, paymentId: string): Promise<PaymentView> {
    const raw = this.store.getCursor(`sweeping-fixture:pay:${paymentId}`);
    if (!raw) throw new IniciadorError(404, "NOT_FOUND", "fixture: no such payment");
    const p = JSON.parse(raw) as { endToEndId: string };
    const completed = { status: "PAYMENT_COMPLETED", endToEndId: p.endToEndId };
    this.store.setCursor(`sweeping-fixture:pay:${paymentId}`, JSON.stringify(completed));
    return { id: paymentId, ...completed };
  }

  private auth(id: string): FixtureAuth | undefined {
    const raw = this.store.getCursor(`sweeping-fixture:auth:${id}`);
    return raw ? (JSON.parse(raw) as FixtureAuth) : undefined;
  }

  private saveAuth(id: string, auth: FixtureAuth): void {
    this.store.setCursor(`sweeping-fixture:auth:${id}`, JSON.stringify(auth));
  }
}
