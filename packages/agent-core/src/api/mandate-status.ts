/**
 * Mandate status from the API, for runs with a test key. `org pauseAll` has
 * no API surface yet (preview with AgentGate), so `org_paused` is answered
 * from the local stub and the report says so through `source`.
 */
import type { ApiClient } from "@codespar/sdk";
import type { MandateStatusSource, MandateStatusReport } from "../revocation.js";
import { describeApiError } from "./client.js";

export class ApiMandateStatusSource implements MandateStatusSource {
  constructor(
    private readonly api: ApiClient,
    private readonly fallback: MandateStatusSource,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async check(mandateId: string): Promise<MandateStatusReport> {
    const local = await this.fallback.check(mandateId);
    try {
      const m = await this.api.get("/v1/mandates/{id}", { path: { id: mandateId } });
      const expired = new Date(m.expires_at).getTime() <= this.clock().getTime();
      return {
        mandate_id: mandateId,
        status: expired && m.status === "active" ? "expired" : m.status,
        org_paused: local.org_paused,
        checked_at: this.clock().toISOString(),
        source: "api",
      };
    } catch (err) {
      const failure = describeApiError(err);
      if (failure.status === 404) return { ...local, status: "revoked", source: "api" };
      throw new Error(`mandate status check failed (${failure.code}): ${failure.message}`);
    }
  }
}
