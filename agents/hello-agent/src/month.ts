/**
 * The month's bills. A deterministic fixture: the demo has no bank feed, so
 * the agent reads this list. Amounts are BRL cents. `alias` matches the
 * named payees of the mandate.
 */
export interface Bill {
  alias: string;
  name: string;
  amount_minor: number;
  due: string;
  reference: string;
}

export const MONTH = "2026-10";

export const BILLS: Bill[] = [
  { alias: "academia", name: "Academia Forte", amount_minor: 14990, due: "2026-10-05", reference: "mensalidade outubro" },
  { alias: "internet", name: "Fibra Net", amount_minor: 11900, due: "2026-10-10", reference: "fatura 10/2026" },
  { alias: "agua", name: "Companhia de Agua", amount_minor: 8735, due: "2026-10-15", reference: "consumo 09/2026" },
];

export function formatBRL(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}
