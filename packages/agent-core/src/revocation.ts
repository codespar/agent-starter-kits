/**
 * Section 4.7: the core asks a status source before `executing`. The
 * approval artifact alone is not enough, because it may predate a
 * revocation. The interface is the contract; the AgentGate-backed source
 * is in preview, so the shipped implementation is the stub in
 * `stubs/agentgate.ts` and, when a test key is present, the API reads in
 * `api/mandate-status.ts`.
 */
export type MandateStatus = "active" | "paused" | "revoked" | "expired";

export interface MandateStatusReport {
  mandate_id: string;
  status: MandateStatus;
  /** True when the organization pressed the kill switch (`org pauseAll`). */
  org_paused: boolean;
  checked_at: string;
  /** Which source answered, so the bundle says whether the check was real. */
  source: "stub" | "api";
}

export interface MandateStatusSource {
  check(mandateId: string): Promise<MandateStatusReport>;
}
