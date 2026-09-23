/**
 * STUB. Stands in for the AgentGate preview surfaces the spec depends on
 * (section 14.6): `codespar mandates revoke`, `codespar org pauseAll`,
 * `mandates list`, `audit replay`. It answers from the local state.db, so a
 * scenario can revoke a mandate mid-run and the core reacts the way section
 * 4.7 says, with no network and no AgentGate. No gate in this delivery
 * waits for the real thing; when it ships, this file is replaced by an
 * implementation of the same `MandateStatusSource` interface.
 */
import type { MandateStatusSource, MandateStatus, MandateStatusReport } from "../revocation.js";
import type { StateStore } from "../state/store.js";

export const STUB_ORG_ID = "org_local_stub";

export class AgentGateStub implements MandateStatusSource {
  constructor(
    private readonly store: StateStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async check(mandateId: string): Promise<MandateStatusReport> {
    const row = this.store.stubMandateStatus(mandateId);
    return {
      mandate_id: mandateId,
      status: (row?.status as MandateStatus | undefined) ?? "active",
      org_paused: this.store.stubOrgPaused(STUB_ORG_ID),
      checked_at: this.clock().toISOString(),
      source: "stub",
    };
  }

  /** `codespar mandates revoke <id>`, locally. */
  revoke(mandateId: string, reason = "revoked by operator"): void {
    this.store.stubSetMandateStatus(mandateId, "revoked", reason, this.clock().toISOString());
  }

  pause(mandateId: string, reason = "paused by operator"): void {
    this.store.stubSetMandateStatus(mandateId, "paused", reason, this.clock().toISOString());
  }

  resume(mandateId: string): void {
    this.store.stubSetMandateStatus(mandateId, "active", null, this.clock().toISOString());
  }

  /** `codespar org pauseAll`, locally. */
  pauseAll(): void {
    this.store.stubSetOrgPaused(STUB_ORG_ID, true, this.clock().toISOString());
  }

  resumeAll(): void {
    this.store.stubSetOrgPaused(STUB_ORG_ID, false, this.clock().toISOString());
  }
}
