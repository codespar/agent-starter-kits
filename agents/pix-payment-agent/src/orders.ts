/**
 * The store's open orders and the one policy this agent runs on them: a Pix charge covers ONE order, in one payment, for
 * exactly the order's total. A deterministic fixture: the demo has no store feed, so the agent reads this book. Amounts
 * are BRL cents. `alias` matches the named entries of the collection policy (`mandate.example.json`); the core resolves it
 * to the customer's document, which the model never sees. The documents are valid CPFs (check digits computed): the
 * clearing house validates them on a cobrança com vencimento.
 */
import type { Execution, Locale, PolicyExtension } from "@codespar/agent-core";
import { STRINGS } from "./strings.js";

export interface Order {
  alias: string;
  customer: string;
  first_name: string;
  document: string;
  item: string;
  total_minor: number;
}

export const ORDERS: Order[] = [
  // The integrated Test's first run: small enough for the platform's Test payer, within R$ 10–30.
  { alias: "pedido-2001", customer: "Lívia Castro", first_name: "Lívia", document: "28461593782", item: "café especial 250 g", total_minor: 1800 },
  // Above the R$ 500,00 of `escalate_above`: in `mandate` it still goes to the store's attendant.
  { alias: "pedido-2002", customer: "Diego Martins", first_name: "Diego", document: "61305728408", item: "moedor elétrico de café", total_minor: 64900 },
  { alias: "pedido-2003", customer: "Helena Prado", first_name: "Helena", document: "47092831504", item: "kit de filtros de papel", total_minor: 2400 },
];

export function orderByAlias(alias: string): Order | undefined {
  const needle = alias.trim().toLowerCase();
  return ORDERS.find((o) => o.alias === needle);
}

export function orderByDocument(document: string): Order | undefined {
  return ORDERS.find((o) => o.document === document);
}

export function formatBRL(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

/** `#2001` from `pedido-2001`. */
export function orderNumber(alias: string): string {
  return `#${alias.replace(/^pedido-/, "")}`;
}

/**
 * The pure check the core runs at every gate. `undefined` means the charge is the order's. It can only refuse: the
 * customers' book, the cap per charge and the window cap stay the policy's.
 */
export function checkOrder(execution: Pick<Execution, "items" | "total">, locale: Locale = "pt-BR"): { reason: "outside_envelope"; detail: string } | undefined {
  const text = STRINGS[locale];
  if (execution.items.length !== 1) return { reason: "outside_envelope", detail: text.gateOneOrder(execution.items.length) };
  const item = execution.items[0]!;
  // A customer the allowlist does not name is refused by the core before this runs; a named one without an order is a fixture defect.
  const order = orderByDocument(item.payee);
  if (!order) return { reason: "outside_envelope", detail: text.gateNoOrder };
  if (item.amount !== order.total_minor) return { reason: "outside_envelope", detail: text.gateAmount(item.amount, order.total_minor, orderNumber(order.alias)) };
  return undefined;
}

export function orderPolicy(locale: () => Locale = () => "pt-BR"): PolicyExtension {
  return (execution) => checkOrder(execution, locale());
}
