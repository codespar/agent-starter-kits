/**
 * The month's bills. A deterministic fixture: the demo has no bank feed, so
 * the agent reads this list. Amounts are BRL cents. `alias` matches the
 * named payees of the mandate; the core resolves it to the pinned Pix key.
 */
import { windowCap, type Mandate } from "@codespar/agent-core";

export interface Bill {
  alias: string;
  name: string;
  amount_minor: number;
  due: string;
  reference: string;
}

export const MONTH = "2026-10";

export const BILLS: Bill[] = [
  { alias: "escola", name: "Escola Aurora", amount_minor: 185000, due: "2026-10-10", reference: "mensalidade outubro" },
  { alias: "mercado", name: "Mercado do Bairro", amount_minor: 64000, due: "2026-10-05", reference: "compras da semana" },
  { alias: "funcionaria", name: "Maria (diarista)", amount_minor: 120000, due: "2026-10-05", reference: "diárias de setembro" },
  { alias: "contas", name: "Energia (conta de luz)", amount_minor: 31590, due: "2026-10-15", reference: "fatura 09/2026" },
];

/** What one bill may ask under a mandate that is not the example's: R$ 10,00, or less when a cap of the mandate is lower. */
export const MANDATE_BILL_MINOR = 1000;

/**
 * The month's bills under `mandate`. The fixture when the mandate names any of its payees (the example, a consent made from
 * it). Under a mandate that names none of them (the platform's Test receivers a host binds a run to), one bill per payee the
 * mandate does name, each within its caps and due `today`: what a person can actually pay in that run, instead of a list the
 * mandate refuses whole.
 */
export function billsFor(mandate: Mandate, today: string): Bill[] {
  if (BILLS.some((b) => mandate.beneficiaries.some((p) => p.alias === b.alias))) return BILLS;
  const each = Math.min(MANDATE_BILL_MINOR, mandate.per_tx_cap_minor, Math.floor(windowCap(mandate) / Math.max(1, mandate.beneficiaries.length)));
  return mandate.beneficiaries.map((p) => ({ alias: p.alias, name: p.name, amount_minor: each, due: today, reference: "conta de teste" }));
}

export function formatBRL(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}
