/**
 * The hosted catalog of THIS repository. The package's own tests check the
 * derivation on a test kit and on whatever `agents/` holds, because a
 * scaffold of one agent carries them; what is true only of the six agents
 * here is asserted here, where a scaffold does not reach.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog, discoverAgentDirs, type HostedKitDescriptor } from "@codespar/agent-runtime";

const ROOT = resolve(import.meta.dirname, "..");
const SHARED = ["packages/agent-core/src", "packages/agent-runtime/src"];

async function catalog(): Promise<Map<string, HostedKitDescriptor>> {
  const built = await buildCatalog({ root: ROOT, commit: "b".repeat(40), shared: SHARED }, discoverAgentDirs(join(ROOT, "agents")), "0.0.0-test");
  return new Map(built.kits.map((k) => [k.id, k]));
}

describe("the hosted catalog of this repository", () => {
  it("has the six agents, discovered from their manifests", async () => {
    expect([...(await catalog()).keys()]).toEqual(["bills-agent", "checkout-agent", "collections-agent", "hello-agent", "supplier-payments-agent", "topup-agent"]);
  });

  it("describes hello-agent as read-only: no mandate, no settlement, nothing to prove", async () => {
    const hello = (await catalog()).get("hello-agent")!;
    expect(hello).toMatchObject({ needsMandate: false, settlement: "none", outcomeKinds: ["answer"], supportedExecutors: ["simulator"] });
    expect(hello.executors).toEqual([{ id: "simulator", evidence: "none", requires: [], blockedBy: [] }]);
  });

  it("describes topup-agent as a pull with no CodeSpar receipt, and checkout-agent as an order with its charge", async () => {
    const kits = await catalog();
    const topup = kits.get("topup-agent")!;
    expect(topup.outcomeKinds).toEqual(["answer", "pull"]);
    expect(topup.supportedExecutors).toEqual(["simulator"]);
    expect(topup.executors.some((e) => e.evidence === "codespar_receipt")).toBe(false);
    expect(kits.get("checkout-agent")!.outcomeKinds).toEqual(["answer", "order", "charge"]);
  });

  it("presents every agent and every example in pt-BR and en", async () => {
    for (const kit of (await catalog()).values()) {
      expect(kit.presentation, kit.id).not.toBeNull();
      for (const locale of ["pt-BR", "en"] as const) expect(kit.presentation![locale].title.length, `${kit.id} ${locale}`).toBeGreaterThan(0);
      for (const example of kit.examples) expect(example.presentation, `${kit.id} ${example.id}`).not.toBeNull();
    }
  });

  it("recommends one first experiment: bills-agent's happy path, which the simulator runs end to end", async () => {
    const recommended = [...(await catalog()).values()].filter((k) => k.recommended);
    expect(recommended.map((k) => [k.id, k.recommended])).toEqual([["bills-agent", { example: "happy-path", rank: 1 }]]);
  });

  it("offers replay for every agent, from the packs it ships", async () => {
    for (const kit of (await catalog()).values()) {
      expect(kit.supportedModelModes, kit.id).toEqual(["replay", "model"]);
      expect(kit.exampleIds, kit.id).toContain("happy-path");
    }
  });
});
