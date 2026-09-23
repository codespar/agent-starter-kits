/**
 * The local view of a consumer mandate: the fields the core checks before
 * anything reaches the API, plus the named payees the kit presents to the
 * person. The API re-verifies all of it server-side on every spend; the
 * local checks exist so a refusal is readable and happens before any call.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const BeneficiarySchema = z
  .object({
    /** Short handle the model may use: `escola`, `mercado`. */
    alias: z.string().regex(/^[a-z0-9_-]+$/),
    name: z.string().min(1),
    /** The pinned payee key. Must appear in `merchant_allowlist`. */
    payee: z.string().min(1),
  })
  .strict();

export const MandateSchema = z
  .object({
    id: z.string().min(1),
    /** Local version counter for the approval artifact; bumps when the mandate is re-signed. */
    version: z.number().int().positive(),
    consumer_id: z.string().min(1),
    agent_id: z.string().min(1),
    purpose: z.string().min(1),
    currency: z.string().min(1),
    /** Section 4.3: total over the window, in minor units. */
    cap_minor: z.number().int().positive(),
    per_tx_cap_minor: z.number().int().positive(),
    periodic_cap: z.object({ window: z.enum(["day", "month"]), cap_minor: z.number().int().positive() }).strict().optional(),
    merchant_pin_kind: z.enum(["pix-key", "merchant-id", "mcc"]),
    /** Concrete keys. The kit never treats `"*"` as authorizing a payee. */
    merchant_allowlist: z.array(z.string().min(1)).nonempty(),
    beneficiaries: z.array(BeneficiarySchema),
    status: z.enum(["active", "paused", "revoked", "expired"]),
    /** ISO 8601. */
    expires_at: z.string().datetime(),
    /** The signature the API returned at consent, when the mandate is a real one. Never required locally. */
    signature: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** The canonical mandate the API returned, presented on `/v1/consumer-payments/execute`. */
    canonical: z.record(z.string(), z.unknown()).optional(),
    /** Where this mandate came from. */
    source: z.enum(["example", "consent"]).default("example"),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.per_tx_cap_minor > m.cap_minor) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["per_tx_cap_minor"], message: "per_tx_cap_minor cannot exceed cap_minor" });
    }
    for (const [i, b] of m.beneficiaries.entries()) {
      if (!m.merchant_allowlist.includes(b.payee)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["beneficiaries", i, "payee"], message: `payee ${b.payee} is not in merchant_allowlist` });
      }
    }
  });

export type Mandate = z.infer<typeof MandateSchema>;
export type Beneficiary = z.infer<typeof BeneficiarySchema>;

export function loadMandate(path: string): Mandate {
  return MandateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The window the monthly cap is counted over. */
export function windowStart(mandate: Mandate, now: Date): Date {
  const window = mandate.periodic_cap?.window ?? "month";
  const d = new Date(now);
  if (window === "day") {
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
  }
  return d;
}

export function windowCap(mandate: Mandate): number {
  return mandate.periodic_cap?.cap_minor ?? mandate.cap_minor;
}

/** A payee is allowed only when the SIGNED list names it. A wildcard names nobody here. */
export function payeeAllowed(mandate: Mandate, payee: string): boolean {
  return mandate.merchant_allowlist.some((entry) => entry !== "*" && entry === payee);
}

export function resolveBeneficiary(mandate: Mandate, aliasOrPayee: string): Beneficiary | undefined {
  const needle = aliasOrPayee.trim().toLowerCase();
  return mandate.beneficiaries.find((b) => b.alias === needle || b.payee.toLowerCase() === needle || b.name.toLowerCase() === needle);
}

export function mandateExpired(mandate: Mandate, now: Date): boolean {
  return new Date(mandate.expires_at).getTime() <= now.getTime();
}
