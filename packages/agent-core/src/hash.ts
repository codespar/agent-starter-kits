import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CompositionLine, ExecutionItem } from "./types.js";

/** JSON with keys sorted at every level, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Section 4.2: the hash of the canonical list. Only the fields that decide
 * where money goes take part: payee, amount, currency, and the due date of a
 * receivable when it has one. Aliases, names and descriptions are
 * presentation and may differ without changing the hash.
 */
export function itemsHash(items: readonly ExecutionItem[]): string {
  const canonical = items.map((item) => ({
    payee: item.payee,
    amount: item.amount,
    currency: item.currency,
    ...(item.due_date ? { due_date: item.due_date } : {}),
  }));
  return `sha256:${sha256Hex(canonicalJson(canonical))}`;
}

/**
 * The hash of a batch's ordered lines, bound into every artifact of that
 * batch. It IS `itemsHash` over the whole list and deliberately not a second
 * canonicalisation: the same fields decide the set that decide the line, so a
 * reader who concatenates the batch's lines in order and hashes them gets the
 * batch's hash back, and any line moved, re-priced, added or dropped changes
 * it. Order is part of it — `index` names a position, and a position only
 * means something in a list whose order is fixed.
 */
export function batchHash(lines: readonly ExecutionItem[]): string {
  return itemsHash(lines);
}

/**
 * The hash of what an execution's amount is composed of (a cart's resolved
 * lines, in order). The same canonicalisation as `itemsHash` — sorted-key
 * JSON, SHA-256, the `sha256:` prefix — over the fields that decide a
 * composition, and deliberately not `itemsHash` itself: its fields are the
 * ones that decide where money goes (payee, amount, currency, due date), and
 * none of them sees a quantity or a unit price. Ten units at a 10% discount
 * and nine at list price are the same line amount; they are not the same
 * sale. Order is part of it, like a batch.
 */
export function compositionHash(lines: readonly CompositionLine[]): string {
  const canonical = lines.map((line) => ({
    ref: line.ref,
    quantity: line.quantity,
    unit_amount: line.unit_amount,
    amount: line.amount,
    currency: line.currency,
  }));
  return `sha256:${sha256Hex(canonicalJson(canonical))}`;
}

export function hmacSha256Hex(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

export function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
