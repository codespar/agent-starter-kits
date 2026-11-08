/**
 * `codespar_account`: what the CodeSpar Test project holds, read through the
 * host (`PlatformReads`). Only on a hosted `codespar-test` run: there is no
 * platform account anywhere else, and this tool says so instead of inventing
 * one. It reads and returns; it touches nothing, and it needs no mandate.
 */
import { maskPayee, type ToolHandler } from "@codespar/agent-core";
import type { PlatformReads } from "@codespar/agent-runtime";

const VIEWS = ["balance", "mandates", "proposals"] as const;
type View = (typeof VIEWS)[number];
const MAX_PROPOSALS = 10;

/** A payee as the model may read it: the host's mask kept, anything that still looks like a key masked. */
function masked(payee: string): string {
  if (payee === "" || /\*\*\*|•/.test(payee)) return payee;
  return maskPayee(payee);
}

/** `reads` is the run's port (`setup.platformReads`), or undefined where no platform is reachable. */
export function codesparAccount(reads: PlatformReads | undefined): ToolHandler {
  return async (input) => {
    const view = input["view"] as View;
    if (!VIEWS.includes(view)) throw new Error(`codespar_account: view must be one of ${VIEWS.join(", ")}`);
    if (!reads) {
      return {
        available: false,
        view,
        message: "There is no CodeSpar account to read here: this run is not on the integrated Test (the simulator and the terminal have none). Nothing was read.",
      };
    }
    if (view === "balance") return { available: true, view, ...(await reads.balance()) };
    // Limits and status only: a mandate's counterparties never reach the model.
    if (view === "mandates") return { available: true, view, mandates: (await reads.mandates()).map(({ id, status, currency, perTxCapMinor, capMinor, periodicCap, expiresAt }) => ({ id, status, currency, perTxCapMinor, capMinor, periodicCap, expiresAt })) };
    const asked = typeof input["limit"] === "number" && Number.isInteger(input["limit"]) ? (input["limit"] as number) : 5;
    const proposals = await reads.proposals(Math.min(Math.max(asked, 1), MAX_PROPOSALS));
    // The host masks every payee; masked again here so a key in the clear can never reach the model, the history or the bundle.
    return { available: true, view, proposals: proposals.map(({ id, state, amountMinor, currency, payeeMasked, createdAt, receiptId }) => ({ id, state, amountMinor, currency, payeeMasked: masked(payeeMasked), createdAt, receiptId })) };
  };
}
