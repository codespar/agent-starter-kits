/**
 * The month's payables, grouped into the batches the company actually runs:
 * suppliers, commissions and payroll. A deterministic fixture, because the
 * demo has no ERP to read. Amounts are BRL cents; `alias` matches the named
 * payees of the mandate and the core resolves it to the pinned Pix key.
 *
 * The lines of a batch live HERE and not in the model's tool call, which is
 * what makes a batch un-fractionable: the model names which batch to run,
 * and the code is what says who is in it and for how much.
 */
import { windowCap, type Mandate } from "@codespar/agent-core";

export interface PayableLine {
  alias: string;
  name: string;
  amount_minor: number;
  reference: string;
}

export interface Batch {
  ref: string;
  kind: "fornecedores" | "comissoes" | "folha";
  label: string;
  due: string;
  lines: PayableLine[];
}

export const MONTH = "2026-10";

export const BATCHES: Batch[] = [
  {
    ref: "fornecedores-2026-10",
    kind: "fornecedores",
    label: "Fornecedores de outubro",
    due: "2026-10-10",
    lines: [
      { alias: "grafica", name: "Gráfica Litoral", amount_minor: 98000, reference: "NF 4471, catálogos" },
      { alias: "insumos", name: "Insumos Atlântico", amount_minor: 125000, reference: "NF 8820, matéria-prima" },
      { alias: "logistica", name: "Transporte Verde", amount_minor: 76000, reference: "NF 1290, fretes de setembro" },
    ],
  },
  {
    ref: "comissoes-2026-10",
    kind: "comissoes",
    label: "Comissões de outubro",
    due: "2026-10-05",
    lines: [
      { alias: "rep-sul", name: "Marcos (representante Sul)", amount_minor: 62000, reference: "comissão sobre setembro" },
      { alias: "rep-norte", name: "Paula (representante Norte)", amount_minor: 48000, reference: "comissão sobre setembro" },
    ],
  },
  {
    ref: "folha-2026-10",
    kind: "folha",
    label: "Folha de outubro",
    due: "2026-10-05",
    lines: [
      { alias: "ana", name: "Ana Ribeiro", amount_minor: 220000, reference: "salário outubro" },
      { alias: "bruno", name: "Bruno Castro", amount_minor: 180000, reference: "salário outubro" },
      { alias: "carla", name: "Carla Dias", amount_minor: 140000, reference: "salário outubro" },
    ],
  },
];

/** What one line may ask under a mandate that is not the example's: R$ 10,00, or less when a cap of the mandate is lower. */
export const MANDATE_LINE_MINOR = 1000;

/**
 * The month's batches under `mandate`. The fixture when the mandate names any payee of it (the example, the organization's
 * own envelope made from it). Under a mandate that names none of them (the platform's Test receivers a host binds a run to),
 * one batch with a line per payee the mandate does name, the whole batch within its caps and due `today`: what a run can
 * actually pay, instead of three batches the mandate refuses line by line.
 */
export function batchesFor(mandate: Mandate, today: string): Batch[] {
  const named = new Set(mandate.beneficiaries.map((p) => p.alias));
  if (BATCHES.some((b) => b.lines.some((l) => named.has(l.alias)))) return BATCHES;
  const each = Math.min(MANDATE_LINE_MINOR, mandate.per_tx_cap_minor, Math.floor(windowCap(mandate) / Math.max(1, mandate.beneficiaries.length)));
  return [
    {
      ref: `teste-${MONTH}`,
      kind: "fornecedores",
      label: "Pagamento de teste",
      due: today,
      lines: mandate.beneficiaries.map((p) => ({ alias: p.alias, name: p.name, amount_minor: each, reference: "pagamento de teste" })),
    },
  ];
}

/** A batch by its ref: the fixture's, or, with a mandate, the batches that mandate can pay (`batchesFor`). */
export function findBatch(ref: string, mandate?: Mandate, today?: string): Batch | undefined {
  return (mandate && today ? batchesFor(mandate, today) : BATCHES).find((b) => b.ref === ref);
}

export function batchTotal(batch: Batch): number {
  return batch.lines.reduce((sum, l) => sum + l.amount_minor, 0);
}

export function formatBRL(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const reais = Math.floor(abs / 100).toLocaleString("pt-BR");
  return `${sign}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}
