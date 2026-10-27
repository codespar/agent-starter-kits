/**
 * The Iniciador sweeping REST, the four calls a pull needs and nothing else:
 * create an authorization (the payer approves it at the bank), read it, create
 * a payment under it, read the payment. Ported from the sandbox probe of
 * 2026-10-21 (`~/Documentos/codespar/iniciador/probe`), which proved the shapes
 * on 2026-10-22; the vendor client is not used.
 *
 * What never leaves this module: the client id, the client secret and the
 * access token. The token lives in memory only, for 55 minutes, and is
 * refreshed once on a 401. Every error message that reaches a caller has been
 * through `scrub`, which masks JWT-shaped strings, both credentials and any run
 * of 11 to 14 digits (a CPF, a CNPJ).
 */

export const SANDBOX_BASE_URL = "https://consumer.sandbox.inic.dev/v1";

/** Authorization statuses that end the wait for the payer. AUTHORISED is the only one that leads to a payment. */
export const AUTHORIZATION_TERMINAL = new Set(["AUTHORISED", "CONSUMED", "REJECTED", "REVOKED", "ERROR", "CANCELED", "EXPIRED"]);
export const PAYMENT_TERMINAL = new Set(["PAYMENT_COMPLETED", "CONSENT_REJECTED", "PAYMENT_REJECTED", "ERROR", "EXPIRED", "CANCELED"]);

export interface SweepingCredentials {
  clientId: string;
  clientSecret: string;
}

/** What one authorization asks the bank for. The two limits are the mandate's caps (see `sweepingLimits`), so the bank and the core cannot disagree. */
export interface AuthorizationRequest {
  externalId: string;
  taxId: string;
  participantId: string;
  creditorId: string;
  triggerId: string;
  totalAllowedAmount: number;
  transactionLimit: number;
  redirectURL?: string | undefined;
}

export interface PaymentRequest {
  externalId: string;
  creditorId: string;
  triggerId: string;
  amount: number;
  description: string;
  riskSignals: RiskSignals;
}

/** MANUAL riskSignals: the only trigger provisioned is MANUAL, and it wants device telemetry. Fixed values plus a device id kept across runs. */
export interface RiskSignals {
  type: "MANUAL";
  deviceId: string;
  osVersion: string;
  userTimeZoneOffset: string;
  language: string;
  screenDimensions: { height: number; width: number };
  accountTenure: string;
}

export interface AuthorizationView {
  authorizationId: string;
  status: string;
  authUrl: string | null;
  /** `rejection.reason.code` when the bank or the clock ended it. */
  rejection: string | null;
}

export interface PaymentView {
  id: string;
  status: string;
  endToEndId: string | null;
}

/** The four calls. The HTTP client implements it against the sandbox; tests and the offline rail implement it in memory. */
export interface SweepingApi {
  createAuthorization(request: AuthorizationRequest): Promise<AuthorizationView>;
  getAuthorization(authorizationId: string): Promise<AuthorizationView>;
  createPayment(authorizationId: string, request: PaymentRequest): Promise<PaymentView>;
  getPaymentStatus(authorizationId: string, paymentId: string): Promise<PaymentView>;
}

/**
 * A call that did not succeed. `status` is the HTTP status, or 0 when no answer
 * came back (network, timeout): the request may or may not have landed.
 */
export class IniciadorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IniciadorError";
  }

  /**
   * No answer (0) or a 5xx: whether the call took effect is unknown. Every
   * 4xx is a certain refusal, 408 and 429 included: the server says it did
   * not process the request (a timeout waiting for it, a rate limit), so
   * nothing took effect. A 429 on the payment request used to leave a marker
   * with no payment id behind, forever unresolvable.
   */
  get uncertain(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const DOCUMENT = /\d{11,14}/g;

/** Masks tokens, the given secrets and any 11-14 digit run. Applied to everything this module puts in an error. */
export function scrub(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(JWT, "<token>");
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("<secret>");
  return out.replace(DOCUMENT, (d) => `${"*".repeat(d.length - 4)}${d.slice(-4)}`);
}

export interface HttpSweepingOptions {
  baseUrl?: string | undefined;
  credentials: SweepingCredentials;
  fetch?: typeof fetch;
  clock?: () => number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

const TOKEN_TTL_MS = 55 * 60 * 1000;

/** Why a base URL is not one the credentials may go to, or undefined when it is. The host is matched exactly, never by a substring. */
export function notSandbox(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "got something that is not a URL";
  }
  if (url.protocol === "https:" && (url.hostname === "sandbox.inic.dev" || url.hostname.endsWith(".sandbox.inic.dev")) && !url.port) return undefined;
  if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port) return undefined;
  return `got ${url.protocol}//${url.host}`;
}

export class HttpSweepingApi implements SweepingApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private token: { value: string; until: number } | undefined;

  constructor(private readonly options: HttpSweepingOptions) {
    // An empty INICIADOR_BASE_URL is an absent one.
    this.baseUrl = (options.baseUrl?.trim() || SANDBOX_BASE_URL).replace(/\/+$/, "");
    // Sandbox by construction: the client id and secret go to the Iniciador sandbox or a local mock, never anywhere else.
    const refusal = notSandbox(this.baseUrl);
    if (refusal) throw new IniciadorError(0, "not_sandbox", `INICIADOR_BASE_URL must be https://consumer.sandbox.inic.dev/v1 (or another *.sandbox.inic.dev) or http://127.0.0.1:<port>; ${refusal}`);
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async createAuthorization(r: AuthorizationRequest): Promise<AuthorizationView> {
    const json = await this.call("POST", "/sweeping/authorizations", {
      user: { taxId: r.taxId },
      participantId: r.participantId,
      creditors: [r.creditorId],
      triggers: [r.triggerId],
      configuration: { totalAllowedAmount: r.totalAllowedAmount, transactionLimit: r.transactionLimit },
      externalId: r.externalId,
      metadata: { agent: "topup-agent" },
      ...(r.redirectURL ? { redirectURL: r.redirectURL } : {}),
    });
    return authorizationOf(json);
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationView> {
    return authorizationOf(await this.call("GET", `/sweeping/authorizations/${encodeURIComponent(authorizationId)}`));
  }

  async createPayment(authorizationId: string, r: PaymentRequest): Promise<PaymentView> {
    const json = await this.call("POST", `/sweeping/authorizations/${encodeURIComponent(authorizationId)}/payments`, {
      triggerId: r.triggerId,
      creditorId: r.creditorId,
      amount: r.amount,
      externalId: r.externalId,
      description: r.description,
      riskSignals: r.riskSignals,
    });
    return paymentOf(json);
  }

  async getPaymentStatus(authorizationId: string, paymentId: string): Promise<PaymentView> {
    return paymentOf(await this.call("GET", `/sweeping/authorizations/${encodeURIComponent(authorizationId)}/payments/${encodeURIComponent(paymentId)}/status`));
  }

  private get secrets(): string[] {
    return [this.options.credentials.clientId, this.options.credentials.clientSecret, ...(this.token ? [this.token.value] : [])];
  }

  private async bearer(forceNew: boolean): Promise<string> {
    if (!forceNew && this.token && this.token.until > this.clock()) return this.token.value;
    const { clientId, clientSecret } = this.options.credentials;
    const json = await this.raw("POST", "/sweeping/auth", { clientId, clientSecret }, undefined);
    const value = (json as { accessToken?: unknown } | null)?.accessToken;
    if (typeof value !== "string" || !value) throw new IniciadorError(0, "auth_no_token", "POST /sweeping/auth answered without an accessToken");
    this.token = { value, until: this.clock() + TOKEN_TTL_MS };
    return value;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    try {
      return await this.raw(method, path, body, await this.bearer(false));
    } catch (e) {
      if (!(e instanceof IniciadorError) || e.status !== 401) throw e;
      return this.raw(method, path, body, await this.bearer(true));
    }
  }

  private async raw(method: "GET" | "POST", path: string, body: unknown, token: string | undefined): Promise<unknown> {
    const label = `${method} ${path.replace(/\/sweeping\/authorizations\/[^/]+/, "/sweeping/authorizations/{id}").replace(/\/payments\/[^/]+/, "/payments/{id}")}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new IniciadorError(0, "network", scrub(`${label}: no answer (${(e as Error).name})`, this.secrets));
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (response.ok) return json;
    const err = (json ?? {}) as { errorCode?: unknown; code?: unknown; message?: unknown; detail?: unknown };
    const code = typeof err.errorCode === "string" ? err.errorCode : typeof err.code === "string" ? err.code : `http_${response.status}`;
    const detail = Array.isArray(err.message) ? err.message.join("; ") : typeof err.message === "string" ? err.message : typeof err.detail === "string" ? err.detail : "";
    throw new IniciadorError(response.status, code, scrub(`${label} -> ${response.status} ${code}${detail ? `: ${detail}` : ""}`.slice(0, 400), this.secrets));
  }
}

function authorizationOf(json: unknown): AuthorizationView {
  const j = (json ?? {}) as { authorizationId?: unknown; status?: unknown; authUrl?: unknown; rejection?: { reason?: { code?: unknown } } };
  if (typeof j.authorizationId !== "string" || typeof j.status !== "string") throw new IniciadorError(0, "unexpected_shape", "authorization answer without authorizationId or status");
  return {
    authorizationId: j.authorizationId,
    status: j.status,
    authUrl: typeof j.authUrl === "string" ? j.authUrl : null,
    rejection: typeof j.rejection?.reason?.code === "string" ? j.rejection.reason.code : null,
  };
}

function paymentOf(json: unknown): PaymentView {
  const j = (json ?? {}) as { id?: unknown; status?: unknown; endToEndId?: unknown };
  if (typeof j.id !== "string" || typeof j.status !== "string") throw new IniciadorError(0, "unexpected_shape", "payment answer without id or status");
  return { id: j.id, status: j.status, endToEndId: typeof j.endToEndId === "string" && j.endToEndId ? j.endToEndId : null };
}
