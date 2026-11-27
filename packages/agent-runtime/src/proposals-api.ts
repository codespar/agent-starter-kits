/**
 * `--rail proposals`: the exported code of a Playground run on the integrated
 * Test (`codespar-test`) reproduces it on the person's machine through the SAME
 * path the hosted run takes. Each attempt becomes ONE platform payment proposal
 * in the run's Playground conversation, under the run's mandate, drafted with
 * the project's Test key (`POST /v1/proposals`, scope `proposals:draft`); a
 * person pays it on its card in the dashboard, and the kit reads it back
 * (`GET /v1/proposals/:id`) until the receipt.
 *
 * Nothing here signs a mandate, funds an account or pays: the key drafts and
 * reads, the server checks the conversation, the mandate and the Playground's
 * own rules, and only a verified person pays. The run's mandate travels in the
 * export as `--playground <context>` (ids, caps, receivers' aliases and names;
 * no key, no signature): the kit's own policy runs on it, and the server checks
 * it again on every draft.
 */
import { z } from "zod";
import { DEFAULT_BASE_URL, type Mandate } from "@codespar/agent-core";
import { ProposalRefusedError, type ProposalRail, type ProposalState } from "./hosted/proposals.js";

export const PlaygroundContextSchema = z
  .object({
    v: z.literal(1),
    conversation_id: z.string().min(1),
    mandate: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]+$/).describe("The Playground mandate (`cm_...` on the platform)."),
        purpose: z.string().min(1).default("playground"),
        cap_minor: z.number().int().positive(),
        per_tx_cap_minor: z.number().int().positive(),
        periodic_cap: z.object({ window: z.enum(["day", "month"]), cap_minor: z.number().int().positive() }).strict().optional(),
        expires_at: z.string().datetime(),
        /** The receivers the mandate names, by alias and name: the server resolves the alias to its key. */
        beneficiaries: z.array(z.object({ alias: z.string().regex(/^[a-z0-9_-]+$/), name: z.string().min(1) }).strict()).nonempty(),
      })
      .strict(),
  })
  .strict();
export type PlaygroundContext = z.infer<typeof PlaygroundContextSchema>;

export class PlaygroundContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundContextError";
  }
}

/** What `--playground` carries: base64url of the context's JSON (one shell word, nothing to quote). */
export function encodePlaygroundContext(ctx: PlaygroundContext): string {
  return Buffer.from(JSON.stringify(ctx), "utf8").toString("base64url");
}

export function decodePlaygroundContext(value: string): PlaygroundContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new PlaygroundContextError("--playground is not a context the Playground exported: copy the commands again from the run's Código tab");
  }
  const ok = PlaygroundContextSchema.safeParse(parsed);
  if (!ok.success) throw new PlaygroundContextError(`--playground does not name the run's conversation and mandate (${ok.error.issues[0]?.path.join(".") ?? "?"}): copy the commands again from the run's Código tab`);
  return ok.data;
}

/**
 * The kit's policy for the run: the run's mandate as the Playground confirmed it. A receiver's payee is its alias,
 * which the server resolves to the platform's key, so no key travels in the export or sits in this process.
 */
export function playgroundMandate(ctx: PlaygroundContext): Mandate {
  const m = ctx.mandate;
  return {
    id: m.id,
    version: 1,
    consumer_id: "playground",
    agent_id: "playground",
    purpose: m.purpose,
    currency: "BRL",
    cap_minor: m.cap_minor,
    per_tx_cap_minor: m.per_tx_cap_minor,
    ...(m.periodic_cap ? { periodic_cap: m.periodic_cap } : {}),
    merchant_pin_kind: "pix-key",
    merchant_allowlist: m.beneficiaries.map((b) => b.alias) as [string, ...string[]],
    beneficiaries: m.beneficiaries.map((b) => ({ alias: b.alias, name: b.name, payee: b.alias })),
    status: "active",
    expires_at: m.expires_at,
    source: "consent",
  };
}

/** The codes the route answers that a retry with the same idempotency key may clear: not a refusal of the request. */
const RETRYABLE = new Set(["proposal_turn_running"]);

export interface HttpProposalRailOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  mandateId: string;
  conversationId: string;
  fetch?: typeof fetch;
}

/** The idempotency key of an attempt's draft: the same attempt drafts one proposal, however often it is asked. */
export function attemptIdempotencyKey(attemptId: string): string {
  return `kit:${attemptId}`.slice(0, 128);
}

/** The platform's proposals over HTTP with the project's Test key: draft one per attempt, read it back. It never pays. */
export function httpProposalRail(options: HttpProposalRailOptions): ProposalRail {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const http = options.fetch ?? fetch;
  const headers = { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" };
  const refusalOf = async (res: Response): Promise<{ code: string; message: string }> => {
    const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } | string } | null;
    const err = body?.error;
    if (err && typeof err === "object") return { code: typeof err.code === "string" ? err.code : `http_${res.status}`, message: typeof err.message === "string" ? err.message : `HTTP ${res.status}` };
    return { code: typeof err === "string" ? err : `http_${res.status}`, message: `HTTP ${res.status}` };
  };
  return {
    async submit(request) {
      const line = request.items[0];
      if (!line || request.items.length !== 1) throw new ProposalRefusedError("one_line_per_proposal", "a proposal pays one line; nothing was drafted");
      const res = await http(`${base}/v1/proposals`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          mandate_id: options.mandateId,
          conversation_id: options.conversationId,
          payee: line.payee,
          amount_minor: line.amountMinor,
          currency: request.currency,
          ...(line.description || line.beneficiary ? { description: (line.description ?? line.beneficiary ?? "").slice(0, 140) } : {}),
          idempotency_key: attemptIdempotencyKey(request.attemptId),
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { proposal: { id: string; state: ProposalState } };
        return { proposalId: body.proposal.id, state: body.proposal.state };
      }
      const refusal = await refusalOf(res);
      // A server error or a running turn: whether it was drafted is unknown, and the same key asks again without a second draft.
      if (res.status >= 500 || RETRYABLE.has(refusal.code)) throw new Error(`${refusal.code}: ${refusal.message}`);
      throw new ProposalRefusedError(refusal.code, refusal.message);
    },
    async read(proposalId) {
      const res = await http(`${base}/v1/proposals/${encodeURIComponent(proposalId)}`, { method: "GET", headers });
      if (!res.ok) {
        const refusal = await refusalOf(res);
        throw new Error(`${refusal.code}: ${refusal.message}`);
      }
      const body = (await res.json()) as { proposal: { state: ProposalState; receipt_id: string | null; failure: { code: string } | null } };
      return { state: body.proposal.state, receiptId: body.proposal.receipt_id, failureCode: body.proposal.failure?.code ?? null };
    },
  };
}

/** What the terminal says on this rail, in the run's locale. */
export const PROPOSALS_STRINGS = {
  "pt-BR": {
    started: (conversationId: string, mandateId: string) =>
      `[proposals] Test integrado: cada pagamento vira uma proposta na conversa ${conversationId} do Playground, sob o mandato ${mandateId}. Quem paga é você, pelo card no dashboard; este processo não assina mandato, não adiciona saldo e não paga.`,
    drafted: (proposalId: string) => `  proposta ${proposalId} criada na conversa do Playground: pague pelo card no dashboard (Pagar). Aguardando o resultado…`,
    timedOut: (proposalId: string, seconds: number) => `  a proposta ${proposalId} ainda aguarda depois de ${seconds} s; rode \`npm run resume\` depois de pagar ou recusar no dashboard`,
  },
  en: {
    started: (conversationId: string, mandateId: string) =>
      `[proposals] Integrated Test: each payment becomes a proposal in the Playground conversation ${conversationId}, under mandate ${mandateId}. You pay it on its card in the dashboard; this process signs no mandate, adds no balance and pays nothing.`,
    drafted: (proposalId: string) => `  proposal ${proposalId} drafted in the Playground conversation: pay it on its card in the dashboard (Pay). Waiting for the result…`,
    timedOut: (proposalId: string, seconds: number) => `  proposal ${proposalId} still waits after ${seconds} s; run \`npm run resume\` after paying or refusing it in the dashboard`,
  },
} as const;
