/**
 * The sandbox PAYER: `POST /v1/test/charges/{chargeId}/pay` (alias
 * `POST /v1/charges/{chargeId}/sandbox/pay`), test environment only. It
 * plays the debtor: the charge goes through the same settlement path a
 * provider `charge-in` webhook takes, `commerce.charge.paid` fans out to the
 * project's triggers, and every record it leaves carries `simulated: true`
 * plus `settled_against: "sandbox_fixture"`. No money moves anywhere. A
 * live-environment key is refused with `sandbox_pay_not_permitted` before
 * anything is read. The route is not in the SDK's OpenAPI document (0.16.4),
 * and `ApiClient.request` refuses an unknown path, so this is a plain
 * `fetch` against the same base URL, key and project header; the key is
 * checked for the `csk_test_` prefix first, like every other call.
 */
import { assertTestKey } from "../secrets.js";
import type { ApiFailure } from "./client.js";
import { DEFAULT_BASE_URL } from "./client.js";

export interface SandboxPaidState {
  charge_id: string;
  status: "paid";
  local_status: string;
  currency: string;
  quoted_minor: number;
  paid_minor: number;
  payment: "full" | "partial" | "over";
  paid_via: string;
  wallet_id: string;
  ledger_entry_id: string | null;
  event: { id: string; type: string } | null;
  simulated: boolean;
  settled_against: string | null;
  money_moved: false;
  idempotent_replay: boolean;
}

export type SandboxPayResult = { ok: true; state: SandboxPaidState } | { ok: false; failure: ApiFailure };

/** Where the payer route lives. The SDK client refuses a path outside its OpenAPI document, so this call is a plain fetch with the same three things. */
export interface SandboxPayerTarget {
  apiKey: string | undefined;
  baseUrl?: string | undefined;
  projectId?: string | undefined;
  timeoutMs?: number;
}

export async function paySandboxCharge(target: SandboxPayerTarget, chargeRef: string, amountMinor?: number): Promise<SandboxPayResult> {
  const apiKey = assertTestKey(target.apiKey);
  const base = (target.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${base}/v1/test/charges/${encodeURIComponent(chargeRef)}/pay`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(target.projectId ? { "x-codespar-project": target.projectId } : {}),
      },
      body: JSON.stringify(amountMinor !== undefined ? { amount_minor: amountMinor } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
      return { ok: false, failure: { status: res.status, code: err?.code ?? `http_${res.status}`, message: err?.message ?? text.slice(0, 200), body } };
    }
    return { ok: true, state: body as SandboxPaidState };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, failure: { status: 0, code: aborted ? "timeout" : "network", message: err instanceof Error ? err.message : String(err) } };
  } finally {
    clearTimeout(timer);
  }
}
