/**
 * The hosted catalog of THIS repository. The package's own tests check the
 * derivation on a test kit and on whatever `agents/` holds, because a
 * scaffold of one agent carries them; what is true only of the seven agents
 * here is asserted here, where a scaffold does not reach.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog, discoverAgentDirs, loadCookbooks, type HostedCatalog, type HostedKitDescriptor } from "@codespar/agent-runtime";

const ROOT = resolve(import.meta.dirname, "..");
const SHARED = ["packages/agent-core/src", "packages/agent-runtime/src"];

async function built(): Promise<HostedCatalog> {
  return buildCatalog({ root: ROOT, commit: "b".repeat(40), shared: SHARED }, discoverAgentDirs(join(ROOT, "agents")), "0.0.0-test");
}

async function catalog(): Promise<Map<string, HostedKitDescriptor>> {
  return new Map((await built()).kits.map((k) => [k.id, k]));
}

describe("the hosted catalog of this repository", () => {
  it("has the seven agents, discovered from their manifests", async () => {
    expect([...(await catalog()).keys()]).toEqual(["bills-agent", "checkout-agent", "collections-agent", "hello-agent", "pix-payment-agent", "supplier-payments-agent", "topup-agent"]);
  });

  it("describes hello-agent as read-only: no mandate, no settlement, nothing to prove, and on the integrated Test only the project", async () => {
    const hello = (await catalog()).get("hello-agent")!;
    expect(hello).toMatchObject({ needsMandate: false, settlement: "none", outcomeKinds: ["answer"], supportedExecutors: ["simulator", "codespar-test"] });
    expect(hello.executors).toEqual([
      { id: "simulator", evidence: "none", requires: [], blockedBy: [] },
      { id: "codespar-test", evidence: "none", requires: ["platform.test_project"], blockedBy: [] },
    ]);
  });

  it("recommends one executable run per kit that can run on the integrated Test with a model: bills, supplier, hello, checkout, collections, pix", async () => {
    const runs = [...(await catalog()).values()].flatMap((k) => k.recommendedRuns.map((r) => [k.id, r.example, r.rank]));
    expect(runs).toEqual([
      ["bills-agent", "conta-teste", 1],
      // The charges (CONTRATO v1.6): within R$ 10-30, the Test payer's per-payment and daily caps.
      ["checkout-agent", "aula-experimental", 4],
      ["collections-agent", "acordo-1150", 5],
      ["hello-agent", "conta-plataforma", 3],
      ["pix-payment-agent", "happy-path", 7],
      ["supplier-payments-agent", "lote-teste", 2],
    ]);
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

  it("pix-payment-agent charges on the integrated Test through the platform's receive proposals (v1.6), the kit's own API rail still blocked", async () => {
    const pix = (await catalog()).get("pix-payment-agent")!;
    expect(pix.presentation).toMatchObject({ "pt-BR": { title: "Pix Payment Agent" }, en: { title: "Pix Payment Agent" } });
    expect(pix.cookbook).toBe("pix-payment-agent");
    expect(pix.exampleIds).toEqual(["charge-expired", "happy-path", "prompt-injection"]);
    expect(pix.executors).toEqual([
      { id: "simulator", evidence: "simulated", requires: [], blockedBy: [] },
      { id: "codespar-test", evidence: "charge_status", requires: ["platform.test_project", "platform.consumer_mandate", "platform.charges"], blockedBy: [] },
    ]);
    expect(pix.capabilityMaturity["bolepix-receivables"]).toBe("blocked");
    expect(pix.tools).toEqual([{ name: "codespar_charge", effect: "charge" }, { name: "list_orders", effect: "read" }]);
    // The business inputs of each example, in both locales.
    for (const example of pix.examples) for (const locale of ["pt-BR", "en"] as const) expect(example.presentation![locale].inputs?.length, `${example.id} ${locale}`).toBeGreaterThan(0);
  });
});

/** The docs cookbook pages at the commit cookbooks.yaml names (codespar-web content/docs/cookbooks/meta.json, `index` left out). */
const DOCS_SLUGS = [
  "shopping-agent", "pix-payment-agent", "ecommerce-checkout", "marketplace-payout", "pay-documents-and-batches", "agent-with-wallet",
  "streaming-chat-agent", "webhook-listener", "multi-tenant", "spaces-first-customer-test", "crypto-pay-agent", "webhook-providers",
  "sandbox-to-live", "kyc-onboarding", "discover-capability", "open-finance-consent", "issue-card-on-mandate", "consumer-spend-ledger",
  "approval-guardrail", "audit-chain-verify", "projects-and-keys",
];

describe("the recipes of this repository (cookbooks.yaml, CONTRATO v1.8)", () => {
  it("lists every docs cookbook exactly once, in the docs' order", async () => {
    expect((await built()).recipes!.map((r) => r.slug)).toEqual(DOCS_SLUGS);
    expect(loadCookbooks(ROOT).docs.repository).toBe("codespar/codespar-web");
  });

  it("finds Pix Payment Agent: hosted on its own kit, with the scope it does not cover", async () => {
    const pix = (await built()).recipes!.find((r) => r.title.en === "Pix Payment Agent")!;
    expect(pix).toMatchObject({ slug: "pix-payment-agent", status: "hosted", kit: "pix-payment-agent", example: "happy-path", coverage: "partial" });
    expect(pix.notCovered!.en).toMatch(/WhatsApp/);
  });

  it("every hosted recipe runs an example of a kit of the catalog; every other one says why and exports through the pinned CLI when local", async () => {
    const catalog = await built();
    for (const r of catalog.recipes!) {
      if (r.status === "hosted") {
        expect(catalog.kits.find((k) => k.id === r.kit)?.exampleIds, r.slug).toContain(r.example);
      } else {
        expect(r.reason, r.slug).not.toBeNull();
        if (r.status === "local") expect(r.command, r.slug).toBe(`npx @codespar/cli@0.22.8 init --template ${r.template}`);
      }
    }
    expect(catalog.recipes!.filter((r) => r.status === "local").map((r) => r.template)).toEqual(["streaming-chat", "multi-tenant"]);
    // D4: the stale framework template pix-agent is retired; no recipe exports it.
    expect(catalog.recipes!.some((r) => r.template === "pix-agent")).toBe(false);
  });

  it("names keys and never a value", async () => {
    const text = JSON.stringify((await built()).recipes);
    expect(text).not.toMatch(/csk_(test|live)_[A-Za-z0-9]/);
    for (const r of (await built()).recipes!) for (const key of r.prerequisites.keys) expect(key).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});
