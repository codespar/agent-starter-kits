/**
 * Iniciador JSR (Pix with a passkey) through their agentic MCP, plus the one
 * REST read the MCP does not answer. The MCP creates the enrollment (the
 * person registers a passkey on Iniciador's hosted page) and each payment
 * (the person signs it on Iniciador's hosted page); its `status_payment` has
 * no Pix end-to-end id and no rejection code, so a terminal payment is read
 * once more at `GET /enrollments/payments/{id}/status`. Shapes proved on the
 * sandbox on 2026-10-27 (`~/Documentos/codespar/iniciador/07-Exercicio-sandbox-2026-10-27.md`);
 * the vendor client is not used.
 *
 * The MCP is JSON-RPC 2.0 over one POST, answered as `text/event-stream`
 * inside that POST, stateless (no `mcp-session-id`). A tool's answer is JSON
 * serialized in `result.content[0].text`.
 *
 * What never leaves this module: the client id, the client secret and both
 * access tokens (agentic and enrollments), in memory for 55 minutes each.
 * The hosted pages' links carry credentials of their own (a PAR request_uri,
 * a JWT); they go to the caller, which hands them to the person and to no
 * log. Every error message has been through `scrub`.
 */
import { IniciadorError, SANDBOX_BASE_URL, notSandbox, scrub, type SweepingCredentials } from "./iniciador.js";

/** The MCP's own vocabulary: `PENDING` until `terminal`; `COMPLETED` is the only one that leads anywhere. */
export interface EnrollmentView {
  authorizationId: string;
  status: string;
  upstreamStatus: string | null;
  terminal: boolean;
  /** The hosted enrollment page; only on create. It expires about a minute after it is made. */
  url: string | null;
}

export interface JsrPaymentView {
  paymentId: string;
  status: string;
  upstreamStatus: string | null;
  terminal: boolean;
  /** The hosted signing page; only on create. About 10 minutes, then the payment ends REJECTED. */
  url: string | null;
  /** The enrollment the MCP bound the payment to: the most recent COMPLETED one of the person at that bank, never chosen. */
  authorizationId: string | null;
  /** From the REST read, on a terminal payment. */
  endToEndId: string | null;
  errorCode: string | null;
}

export interface Creditor {
  name: string;
  taxId: string;
  ispb: string;
  issuer: string;
  number: string;
  accountType: string;
}

/** The device fields `create_authorization` takes. Fixed values, like the sweeping rail's MANUAL riskSignals. */
export interface DeviceContext {
  osVersion: string;
  userTimeZoneOffset: string;
  language: string;
  screenDimensions: { width: number; height: number };
  accountTenure: string;
}

export interface EnrollmentRequest {
  externalId: string;
  participantId: string;
  taxId: string;
  userName: string;
  agentReason: string;
  deviceContext: DeviceContext;
}

export interface JsrPaymentRequest {
  externalId: string;
  participantId: string;
  taxId: string;
  userName: string;
  amount: number;
  creditor: Creditor;
  description: string;
  agentReason: string;
}

/** The calls the rail makes. The HTTP client implements it against the sandbox; tests and the offline rail in memory. */
export interface JsrApi {
  /** The person's most recent COMPLETED enrollment at that bank, or null: the one the MCP will bind a payment to. */
  completedEnrollment(taxId: string, participantId: string): Promise<EnrollmentView | null>;
  createEnrollment(request: EnrollmentRequest): Promise<EnrollmentView>;
  getEnrollment(authorizationId: string): Promise<EnrollmentView>;
  createPayment(request: JsrPaymentRequest): Promise<JsrPaymentView>;
  getPayment(paymentId: string): Promise<JsrPaymentView>;
}

export interface HttpJsrOptions {
  baseUrl?: string | undefined;
  credentials: SweepingCredentials;
  /** `x-agent-id`: an audit label the MCP stores as `metadata.agentId`. */
  agentId?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
}

const TOKEN_TTL_MS = 55 * 60 * 1000;
const AGENT_ID = "codespar-topup-agent";

export class HttpJsrApi implements JsrApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<string, { value: string; until: number }>();
  private rpcId = 0;
  private initialized = false;

  constructor(private readonly options: HttpJsrOptions) {
    this.baseUrl = (options.baseUrl?.trim() || SANDBOX_BASE_URL).replace(/\/+$/, "");
    const refusal = notSandbox(this.baseUrl);
    if (refusal) throw new IniciadorError(0, "not_sandbox", `INICIADOR_BASE_URL must be https://consumer.sandbox.inic.dev/v1 (or another *.sandbox.inic.dev) or http://127.0.0.1:<port>; ${refusal}`);
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async completedEnrollment(taxId: string, participantId: string): Promise<EnrollmentView | null> {
    const json = (await this.tool("list_authorizations", { taxId })) as { data?: unknown };
    const rows = Array.isArray(json?.data) ? (json.data as Array<Record<string, unknown>>) : [];
    const completed = rows
      .filter((r) => r["status"] === "COMPLETED" && r["participantId"] === participantId && typeof r["authorizationId"] === "string")
      .sort((a, b) => String(b["createdAt"] ?? "").localeCompare(String(a["createdAt"] ?? "")));
    const top = completed[0];
    return top ? enrollmentOf(top) : null;
  }

  async createEnrollment(r: EnrollmentRequest): Promise<EnrollmentView> {
    const json = await this.tool("create_authorization", {
      participantId: r.participantId,
      user: { taxId: r.taxId, name: r.userName },
      externalId: r.externalId,
      agentReason: r.agentReason,
      deviceContext: r.deviceContext,
    });
    return enrollmentOf({ status: "PENDING", terminal: false, ...(json as object) });
  }

  async getEnrollment(authorizationId: string): Promise<EnrollmentView> {
    const json = await this.tool("status_authorization", { authorizationId });
    // The status answer has no url; a link the person was already sent is the caller's to keep.
    return { ...enrollmentOf({ authorizationId, ...(json as object) }), url: null };
  }

  async createPayment(r: JsrPaymentRequest): Promise<JsrPaymentView> {
    const json = await this.tool("create_payment", {
      participantId: r.participantId,
      user: { taxId: r.taxId, name: r.userName },
      amount: r.amount,
      method: "PIX_MANU",
      creditor: r.creditor,
      description: r.description,
      agentReason: r.agentReason,
      externalId: r.externalId,
    });
    return paymentOf({ status: "PENDING", terminal: false, ...(json as object) });
  }

  async getPayment(paymentId: string): Promise<JsrPaymentView> {
    const seen = paymentOf({ paymentId, ...((await this.tool("status_payment", { paymentId })) as object) });
    if (!seen.terminal) return { ...seen, url: null };
    // Terminal: the end-to-end id and the rejection code exist only on the REST side.
    const rest = (await this.rest("GET", `/enrollments/payments/${encodeURIComponent(paymentId)}/status`)) as { endToEndId?: unknown; status?: unknown; error?: { code?: unknown } } | null;
    return {
      ...seen,
      url: null,
      endToEndId: typeof rest?.endToEndId === "string" && rest.endToEndId ? rest.endToEndId : null,
      errorCode: typeof rest?.error?.code === "string" ? rest.error.code : null,
    };
  }

  private get secrets(): string[] {
    return [this.options.credentials.clientId, this.options.credentials.clientSecret, ...[...this.tokens.values()].map((t) => t.value)];
  }

  /** `kind` is the auth path: `/agentic/auth` for the MCP, `/enrollments/auth` for the REST read. */
  private async bearer(kind: "/agentic/auth" | "/enrollments/auth", forceNew: boolean): Promise<string> {
    const cached = this.tokens.get(kind);
    if (!forceNew && cached && cached.until > this.clock()) return cached.value;
    const { clientId, clientSecret } = this.options.credentials;
    const json = await this.http("POST", kind, { clientId, clientSecret }, undefined);
    const value = (json.body as { accessToken?: unknown } | null)?.accessToken;
    if (typeof value !== "string" || !value) throw new IniciadorError(0, "auth_no_token", `POST ${kind} answered without an accessToken`);
    this.tokens.set(kind, { value, until: this.clock() + TOKEN_TTL_MS });
    return value;
  }

  private async rest(method: "GET", path: string): Promise<unknown> {
    try {
      return (await this.http(method, path, undefined, await this.bearer("/enrollments/auth", false))).body;
    } catch (e) {
      if (!(e instanceof IniciadorError) || e.status !== 401) throw e;
      return (await this.http(method, path, undefined, await this.bearer("/enrollments/auth", true))).body;
    }
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized) {
      await this.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: AGENT_ID, version: "0.1.0" } });
      this.initialized = true;
    }
    const result = (await this.rpc("tools/call", { name, arguments: args })) as { isError?: unknown; content?: Array<{ text?: unknown }> } | null;
    const text = typeof result?.content?.[0]?.text === "string" ? result.content[0].text : "";
    // A tool that answered isError did not do what was asked: a certain refusal, like a 4xx.
    if (result?.isError) throw new IniciadorError(422, "tool_error", scrub(`MCP ${name}: ${text}`.slice(0, 400), this.secrets));
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new IniciadorError(0, "unexpected_shape", `MCP ${name} answered text that is not JSON`);
    }
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const send = async (forceNew: boolean) => {
      const id = ++this.rpcId;
      const answer = await this.http("POST", "/agentic/mcp", { jsonrpc: "2.0", id, method, params }, await this.bearer("/agentic/auth", forceNew), method === "tools/call" ? `MCP ${(params as { name: string }).name}` : `MCP ${method}`);
      return { id, answer };
    };
    let sent: Awaited<ReturnType<typeof send>>;
    try {
      sent = await send(false);
    } catch (e) {
      if (!(e instanceof IniciadorError) || e.status !== 401) throw e;
      sent = await send(true);
    }
    const message = rpcMessage(sent.answer.text, sent.answer.contentType, sent.id);
    if (!message) throw new IniciadorError(0, "unexpected_shape", `MCP ${method}: no JSON-RPC answer with id ${sent.id}`);
    if (message.error) throw new IniciadorError(422, `rpc_${String(message.error.code ?? "error")}`, scrub(`MCP ${method}: ${String(message.error.message ?? "")}`.slice(0, 400), this.secrets));
    return message.result;
  }

  private async http(method: "GET" | "POST", path: string, body: unknown, token: string | undefined, label = `${method} ${path.replace(/\/payments\/[^/]+/, "/payments/{id}")}`): Promise<{ body: unknown; text: string; contentType: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          accept: path === "/agentic/mcp" ? "application/json, text/event-stream" : "application/json",
          ...(path === "/agentic/mcp" ? { "x-agent-id": this.options.agentId ?? AGENT_ID } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
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
    if (response.ok) return { body: json, text, contentType: response.headers.get("content-type") ?? "" };
    const err = (json ?? {}) as { errorCode?: unknown; code?: unknown; message?: unknown };
    const code = typeof err.errorCode === "string" ? err.errorCode : typeof err.code === "string" ? err.code : `http_${response.status}`;
    const detail = Array.isArray(err.message) ? err.message.join("; ") : typeof err.message === "string" ? err.message : "";
    throw new IniciadorError(response.status, code, scrub(`${label} -> ${response.status} ${code}${detail ? `: ${detail}` : ""}`.slice(0, 400), this.secrets));
  }
}

interface RpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** The JSON-RPC answer with `id`, from a plain JSON body or from the `data:` lines of an event stream. */
export function rpcMessage(text: string, contentType: string, id: number): RpcMessage | undefined {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    // One event per blank-line-separated block; its data lines joined are one JSON message.
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // not JSON: a keep-alive or a comment
      }
    }
  } else {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      return undefined;
    }
  }
  for (const c of candidates.flat()) if (c && typeof c === "object" && (c as RpcMessage).id === id) return c as RpcMessage;
  return undefined;
}

function enrollmentOf(j: Record<string, unknown>): EnrollmentView {
  if (typeof j["authorizationId"] !== "string" || typeof j["status"] !== "string") throw new IniciadorError(0, "unexpected_shape", "enrollment answer without authorizationId or status");
  return {
    authorizationId: j["authorizationId"],
    status: j["status"],
    upstreamStatus: typeof j["upstreamStatus"] === "string" ? j["upstreamStatus"] : null,
    terminal: j["terminal"] === true,
    url: typeof j["url"] === "string" ? j["url"] : null,
  };
}

function paymentOf(j: Record<string, unknown>): JsrPaymentView {
  if (typeof j["paymentId"] !== "string" || typeof j["status"] !== "string") throw new IniciadorError(0, "unexpected_shape", "payment answer without paymentId or status");
  return {
    paymentId: j["paymentId"],
    status: j["status"],
    upstreamStatus: typeof j["upstreamStatus"] === "string" ? j["upstreamStatus"] : null,
    terminal: j["terminal"] === true,
    url: typeof j["url"] === "string" ? j["url"] : null,
    authorizationId: typeof j["authorizationId"] === "string" ? j["authorizationId"] : null,
    endToEndId: null,
    errorCode: null,
  };
}
