/**
 * Module `integrated-proof`: the bills-agent against a project of the
 * restricted integrated Celcoin proof (codespar-enterprise
 * `integrated-sandbox.ts`). The operator names one consumer per project; that
 * consumer pays from its OWN active `pix-celcoin` funding source
 * (`fs_celcoin_<consumer>`, opened by onboarding) at the Celcoin sandbox, under
 * the proof's limits.
 *
 * Opt-in by environment, nothing changes without it:
 *   BILLS_CONSUMER_ID         the consumer named in INTEGRATED_SANDBOX_PROJECTS
 *   BILLS_PROOF_RECEIVER_KEY  the proof's test receiver Pix key (EVP), the only payee
 *
 * What it refuses, before anything is created at the API:
 *   - a consumer without exactly one active `fs_celcoin_<consumer>` source in
 *     the key's project (no Celcoin binding means the consent would fall back
 *     to a new `pix-consent` source, the Mercado Pago path, or the simulator);
 *   - a local mandate that belongs to another consumer or another funding source.
 * And after the consent: a signed mandate whose consumer or funding source is
 * not the one checked. The consent never funds: the proof's account is credited
 * once, by the operator, under the proof's own ceiling.
 */
import type { ApiClient } from "@codespar/sdk";
import type { Mandate } from "@codespar/agent-core";
import type { Bill } from "../bills.js";

export interface IntegratedProof {
  consumerId: string;
  receiverKey: string;
}

/** R$ 10,00: the terminal's share of the proof budget, as the mandate's every cap. */
export const INTEGRATED_CAP_MINOR = 1000;
export const RECEIVER_ALIAS = "recebedor-prova";

const CONSUMER_RE = /^[A-Za-z0-9_-]+$/;
const EVP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IntegratedProofError extends Error {
  constructor(
    readonly code: "config" | "no_celcoin_source" | "wrong_consumer" | "wrong_funding_source",
    message: string,
  ) {
    super(message);
    this.name = "IntegratedProofError";
  }
}

/** The proof's settings from the environment, or null when the kit runs as before. */
export function integratedProofFrom(env: Record<string, string | undefined>): IntegratedProof | null {
  const consumerId = env["BILLS_CONSUMER_ID"]?.trim();
  const receiverKey = env["BILLS_PROOF_RECEIVER_KEY"]?.trim();
  if (!consumerId && !receiverKey) return null;
  if (!consumerId || !CONSUMER_RE.test(consumerId)) {
    throw new IntegratedProofError("config", "BILLS_CONSUMER_ID must name the proof's consumer ([A-Za-z0-9_-]+)");
  }
  if (!receiverKey || !EVP_RE.test(receiverKey)) {
    throw new IntegratedProofError("config", "BILLS_PROOF_RECEIVER_KEY must be the proof receiver's EVP key");
  }
  return { consumerId, receiverKey };
}

export const celcoinSourceId = (consumerId: string): string => `fs_celcoin_${consumerId}`;

/** The example mandate rewritten for the proof: its consumer, one payee (the test receiver), R$ 10,00 caps. */
export function integratedExample(base: Mandate, proof: IntegratedProof): Mandate {
  return {
    ...base,
    consumer_id: proof.consumerId,
    purpose: "conta de teste da prova integrada",
    cap_minor: INTEGRATED_CAP_MINOR,
    per_tx_cap_minor: INTEGRATED_CAP_MINOR,
    periodic_cap: { window: "month", cap_minor: INTEGRATED_CAP_MINOR },
    merchant_allowlist: [proof.receiverKey],
    beneficiaries: [{ alias: RECEIVER_ALIAS, name: "Recebedor de teste da prova", payee: proof.receiverKey }],
  };
}

/** The bills the agent reads in the proof: one within the R$ 10,00 cap, one above it. */
export const INTEGRATED_BILLS: Bill[] = [
  { alias: RECEIVER_ALIAS, name: "Recebedor de teste da prova", amount_minor: 1000, due: "2026-10-20", reference: "conta de teste (sandbox Celcoin)" },
  { alias: RECEIVER_ALIAS, name: "Recebedor de teste da prova", amount_minor: 2000, due: "2026-10-20", reference: "conta acima do teto do mandato (R$ 10,00), dentro do limite da prova (R$ 50,00)" },
];

interface FundingSourceRow {
  id?: unknown;
  consumer_id?: unknown;
  rail?: unknown;
  status?: unknown;
}

/** Exactly one active `fs_celcoin_<consumer>` source of this consumer in the key's project, read before any write. */
export async function assertCelcoinBinding(api: ApiClient, proof: IntegratedProof): Promise<string> {
  const list = (await (api as unknown as { get: (p: string, o: unknown) => Promise<unknown> }).get("/v1/consumers/funding-sources", {
    query: { consumer_id: proof.consumerId },
  })) as { funding_sources?: FundingSourceRow[] };
  const rows = Array.isArray(list?.funding_sources) ? list.funding_sources : [];
  const expected = celcoinSourceId(proof.consumerId);
  const celcoin = rows.filter((r) => r.rail === "pix-celcoin" && r.status === "active");
  if (celcoin.some((r) => r.consumer_id !== proof.consumerId)) {
    throw new IntegratedProofError("wrong_consumer", `the API answered a source of another consumer for ${proof.consumerId}; nothing was created`);
  }
  if (celcoin.length !== 1 || celcoin[0]!.id !== expected) {
    throw new IntegratedProofError(
      "no_celcoin_source",
      `${proof.consumerId} has no single active Celcoin source ${expected} in this project; nothing was created (no pix-consent fallback)`,
    );
  }
  return expected;
}

/** The signed (or stored) mandate is this consumer's, on its Celcoin source. */
export function assertMandateBinding(mandate: { consumer_id?: unknown; canonical?: Record<string, unknown> | undefined }, proof: IntegratedProof, where: string): void {
  if (mandate.consumer_id !== proof.consumerId) {
    throw new IntegratedProofError("wrong_consumer", `${where}: the mandate is for another consumer, not ${proof.consumerId}`);
  }
  const fs = mandate.canonical?.["funding_source_id"];
  if (fs !== celcoinSourceId(proof.consumerId)) {
    throw new IntegratedProofError("wrong_funding_source", `${where}: the mandate is not on ${celcoinSourceId(proof.consumerId)}`);
  }
}
