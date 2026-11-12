/**
 * The rail the kit builds: one limit, two readers. `TOPUP_TOTAL_CENTS` and
 * `TOPUP_TX_LIMIT_CENTS` are read once, and the mandate's caps and the bank
 * authorization the simulated rail asks for both carry them. `--rail api` is
 * refused, never answered with the simulation in its place.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { StateStore, loadMandate, type RailPayment } from "@codespar/agent-core";
import type { RailContext } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { FixtureSweepingApi, type AuthorizationRequest } from "../src/modules/sweeping-pull.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function context(kind: RailContext["kind"], env: Record<string, string>): RailContext {
  const dir = mkdtempSync(join(tmpdir(), "topup-kit-rail-"));
  tempDirs.push(dir);
  return {
    kind,
    env,
    agentDir: AGENT_DIR,
    stateDir: dir,
    store: new StateStore(join(dir, "state.db")),
    now: undefined,
    mandate: loadMandate(join(AGENT_DIR, "mandate.example.json")),
    stubRail: undefined,
    envVar: (name: string) => env[`TOPUP_${name}`],
  } as unknown as RailContext;
}

function payment(payee: string, amount_minor: number, attempt_id = "att_kit_1"): RailPayment {
  return {
    attempt_id,
    mandate_id: "pol_topup",
    amount_minor,
    currency: "BRL",
    payee,
    purpose: "topup",
    agent_id: "topup-agent",
    actor: { type: "agent", agent: "topup-agent", on_behalf_of: "usr_demo" },
  };
}

describe("the rail the kit builds", () => {
  it("puts the same two limits in the mandate's caps and in the bank authorization", async () => {
    const asked: AuthorizationRequest[] = [];
    const original = FixtureSweepingApi.prototype.createAuthorization;
    vi.spyOn(FixtureSweepingApi.prototype, "createAuthorization").mockImplementation(function (this: FixtureSweepingApi, request: AuthorizationRequest) {
      asked.push(request);
      return original.call(this, request);
    });

    const built = agent.kit.buildRail(context("stub", { TOPUP_TOTAL_CENTS: "800", TOPUP_TX_LIMIT_CENTS: "300" }));
    expect(built.mandate.cap_minor).toBe(800);
    expect(built.mandate.per_tx_cap_minor).toBe(300);

    const payee = built.mandate.beneficiaries[0]!.payee;
    expect(await built.rail.pay(payment(payee, 301, "att_over"))).toMatchObject({ status: "failed", code: "above_transaction_limit" });
    expect((await built.rail.pay(payment(payee, 300))).status).toBe("accepted");

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ totalLimitMinor: built.mandate.cap_minor, perPullLimitMinor: built.mandate.per_tx_cap_minor, payee });
  });

  it("uses R$ 10,00 and R$ 5,00 when neither variable is set", () => {
    const built = agent.kit.buildRail(context("stub", {}));
    expect(built.mandate.cap_minor).toBe(1000);
    expect(built.mandate.per_tx_cap_minor).toBe(500);
  });

  it("refuses --rail api instead of falling back to the simulation", () => {
    expect(() => agent.kit.buildRail(context("api", {}))).toThrow(/no live rail/);
  });
});
