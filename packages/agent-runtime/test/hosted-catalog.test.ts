/**
 * The deploy-time catalog and the contract's fixtures. The catalog is derived
 * (CONTRATO.md section 1) and validated by the same schema the host uses; the
 * fixtures under `fixtures/hosted/` are the JSON the dashboard builds against,
 * and they must stay valid under the schema this package ships.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgent } from "../src/agent.js";
import { buildCatalog, describeKit, discoverAgentDirs, treeDigest } from "../src/hosted/catalog.js";
import { HostedCatalogSchema, HostedKitDescriptorSchema, RunSnapshotSchema, checkEventLog, type HostedEvent, type HostedKitDescriptor } from "../src/hosted/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const TEST_KIT = join(HERE, "fixtures/kits/tip-jar-agent");
const FIXTURES = join(HERE, "fixtures/hosted");
const COMMIT = "a".repeat(40);
const SHARED = ["packages/agent-core/src", "packages/agent-runtime/src"];
const scratch = mkdtempSync(join(tmpdir(), "hosted-catalog-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The test kit's files with only its read tool: what `describeKit` reads from disk, without importing a module from outside the workspace. */
function readOnlyCopy(): string {
  const dir = mkdtempSync(join(ROOT, "packages/agent-runtime/test/fixtures/kits/.read-only-"));
  cpSync(TEST_KIT, dir, { recursive: true });
  const tools = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")) as { meta_tools: unknown[]; local_tools: unknown[] };
  writeFileSync(join(dir, "tools.json"), JSON.stringify({ meta_tools: [], local_tools: tools.local_tools }));
  copies.push(dir);
  return dir;
}
const copies: string[] = [];
afterAll(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

const json = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;

// Only the test kit and whatever agents/ holds: a scaffold of one agent runs this file too. The repository's own six are asserted in the root test/.
describe("buildCatalog", () => {
  it("describes every agent under agents/ plus a kit nobody listed, sorted, from one commit", async () => {
    const dirs = discoverAgentDirs(join(ROOT, "agents"));
    const catalog = await buildCatalog({ root: ROOT, commit: COMMIT, shared: SHARED }, [...dirs, TEST_KIT], "0.0.0-test");
    expect(catalog.kits.map((k) => k.id)).toEqual([...dirs.map((d) => d.split("/").pop()!), "tip-jar-agent"].sort());
    expect(HostedCatalogSchema.safeParse(catalog).success).toBe(true);
    for (const kit of catalog.kits) expect(kit.source.commit).toBe(COMMIT);
  });

  it("derives what a read-only kit is: no mandate, no settlement, no evidence", async () => {
    const tipJar = await loadAgent(TEST_KIT);
    // The same kit with its payment tool taken away is a read-only kit.
    const readOnly = describeKit({ ...tipJar, dir: readOnlyCopy() }, { root: ROOT, commit: COMMIT, shared: SHARED });
    expect(readOnly).toMatchObject({ needsMandate: false, settlement: "none", outcomeKinds: ["answer"], supportedExecutors: ["simulator"] });
    expect(readOnly.executors).toEqual([{ id: "simulator", evidence: "none", requires: [], blockedBy: [] }]);
  });

  it("takes a kit's declared outcomes and refuses one no tool can produce", async () => {
    const tipJar = await loadAgent(TEST_KIT);
    expect(describeKit({ ...tipJar, kit: { ...tipJar.kit, hosted: { outcomeKinds: ["answer", "payment"] as const } } }, { root: ROOT, commit: COMMIT, shared: SHARED }).outcomeKinds).toEqual(["answer", "payment"]);
    const lying = { ...tipJar, dir: readOnlyCopy(), kit: { ...tipJar.kit, hosted: { outcomeKinds: ["answer", "payment"] as const } } };
    expect(() => describeKit(lying, { root: ROOT, commit: COMMIT, shared: SHARED })).toThrow(/not backed by any tool/);
  });

  it("carries a kit's presentation, and refuses one that misses an example or names a pack that does not exist", async () => {
    const agent = await loadAgent(TEST_KIT);
    expect(describeKit(agent, { root: ROOT, commit: COMMIT, shared: SHARED }).presentation).toBeNull();
    const dir = readOnlyCopy();
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf8");
    const words = (example: string) => `    title: "Gorjeta"\n    summary: "Paga uma gorjeta."\n    examples:\n      ${example}:\n        title: "Gorjeta ao barista"\n        description: "Dez reais ao barista."\n`;
    writeFileSync(join(dir, "agent.yaml"), `${yaml}presentation:\n  pt-BR:\n${words("happy-path")}  en:\n${words("happy-path")}`);
    const presented = describeKit({ ...agent, dir }, { root: ROOT, commit: COMMIT, shared: SHARED });
    expect(presented.presentation!["pt-BR"]).toEqual({ title: "Gorjeta", summary: "Paga uma gorjeta." });
    expect(presented.examples[0]!.presentation!.en).toEqual({ title: "Gorjeta ao barista", description: "Dez reais ao barista." });
    writeFileSync(join(dir, "agent.yaml"), `${yaml}presentation:\n  pt-BR:\n${words("other-pack")}  en:\n${words("other-pack")}`);
    expect(() => describeKit({ ...agent, dir }, { root: ROOT, commit: COMMIT, shared: SHARED })).toThrow(/no words for example happy-path/);
    // A recommended first experiment is carried, and one naming a pack that does not exist is refused.
    writeFileSync(join(dir, "agent.yaml"), `${yaml}presentation:\n  recommended:\n    example: happy-path\n  pt-BR:\n${words("happy-path")}  en:\n${words("happy-path")}`);
    expect(describeKit({ ...agent, dir }, { root: ROOT, commit: COMMIT, shared: SHARED }).recommended).toEqual({ example: "happy-path", rank: 1 });
    writeFileSync(join(dir, "agent.yaml"), `${yaml}presentation:\n  recommended:\n    example: no-such-pack\n  pt-BR:\n${words("happy-path")}  en:\n${words("happy-path")}`);
    expect(() => describeKit({ ...agent, dir }, { root: ROOT, commit: COMMIT, shared: SHARED })).toThrow(/recommended names no-such-pack/);
  });

  it("offers codespar-test to a kit whose money moves on the CodeSpar API, and to no other", async () => {
    const agent = await loadAgent(TEST_KIT);
    const onApi = describeKit(agent, { root: ROOT, commit: COMMIT, shared: SHARED });
    expect(onApi.supportedExecutors).toEqual(["simulator", "codespar-test"]);
    expect(onApi.executors[1]).toEqual({ id: "codespar-test", evidence: "codespar_receipt", requires: ["platform.test_project", "platform.consumer_mandate", "platform.payouts"], blockedBy: [] });
    const elsewhere = describeKit({ ...agent, kit: { ...agent.kit, apiRailKey: "none" } }, { root: ROOT, commit: COMMIT, shared: SHARED });
    expect(elsewhere.supportedExecutors).toEqual(["simulator"]);
  });
});

describe("treeDigest", () => {
  it("is stable, ignores what never ships, and moves when a shipped byte moves", () => {
    const root = mkdtempSync(join(scratch, "tree-"));
    cpSync(TEST_KIT, join(root, "kit"), { recursive: true });
    const first = treeDigest(root, ["kit"]);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(treeDigest(root, ["kit"])).toBe(first);
    writeFileSync(join(root, "kit", ".env"), "IGNORED=1\n");
    for (const local of ["runs", ".codespar", "node_modules"]) {
      mkdirSync(join(root, "kit", local));
      writeFileSync(join(root, "kit", local, "x.json"), "{}\n");
    }
    expect(treeDigest(root, ["kit"])).toBe(first);
    writeFileSync(join(root, "kit", "SYSTEM_PROMPT.md"), readFileSync(join(root, "kit", "SYSTEM_PROMPT.md"), "utf8") + "\n");
    expect(treeDigest(root, ["kit"])).not.toBe(first);
  });
});

describe("contract fixtures (playground-executavel/fixtures)", () => {
  it("the catalog fixture is a valid catalog of the six kits", () => {
    const catalog = HostedCatalogSchema.parse(json("catalog.json"));
    expect(catalog.kits.map((k: HostedKitDescriptor) => k.id)).toEqual(["bills-agent", "checkout-agent", "collections-agent", "hello-agent", "supplier-payments-agent", "topup-agent"]);
    for (const k of catalog.kits) expect(HostedKitDescriptorSchema.safeParse(k).success).toBe(true);
    // topup is not a CodeSpar payment and never claims a CodeSpar receipt.
    const topup = catalog.kits.find((k) => k.outcomeKinds.includes("pull"))!;
    expect(topup.executors.every((e) => e.evidence !== "codespar_receipt")).toBe(true);
  });

  it("every event log is gapless, from one run, and valid event by event", () => {
    for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".events.json"))) {
      const log = json(name) as { runId: string; events: HostedEvent[] };
      expect(checkEventLog(log.events), name).toEqual([]);
      expect(log.events.every((e) => e.runId === log.runId), name).toBe(true);
    }
  });

  it("every snapshot is valid, and its cursor is the last event of its log", () => {
    for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".snapshot.json"))) {
      const result = RunSnapshotSchema.safeParse(json(name));
      expect(result.success, `${name}: ${result.success ? "" : JSON.stringify(result.error.issues.slice(0, 3))}`).toBe(true);
    }
    const bills = RunSnapshotSchema.parse(json("bills-awaiting-approval.snapshot.json"));
    const billsLog = json("bills-awaiting-approval.events.json") as { events: HostedEvent[] };
    expect(bills.cursor.seq).toBe(billsLog.events.length);
    expect(bills.pending.map((p) => p.kind)).toEqual(["decision"]);
    const supplier = RunSnapshotSchema.parse(json("supplier-batch-one-refused.snapshot.json"));
    const supplierLog = json("supplier-batch-one-refused.events.json") as { events: HostedEvent[] };
    expect(supplier.cursor.seq).toBe(supplierLog.events.length);
    expect(supplier.batches[0]!.lines.map((l) => l.state)).toEqual(["settled", "failed", "settled"]);
    expect(supplier.batches[0]!.settledMinor).toBe(supplier.executions.filter((e) => e.state === "settled").reduce((sum, e) => sum + e.totalMinor, 0));
    const awaiting = RunSnapshotSchema.parse(json("supplier-batch-awaiting-decision.snapshot.json"));
    expect(awaiting.pending.map((p) => p.kind)).toEqual(["batch_decision"]);
  });

  it("the reconnect answer starts right after the cursor the client had and ends at the snapshot's", () => {
    const r = json("reconnect-after-cursor.json") as { request: { after: number }; response: { events: HostedEvent[]; cursor: { seq: number } } };
    expect(checkEventLog(r.response.events, r.request.after)).toEqual([]);
    expect(r.response.events.at(-1)!.seq).toBe(r.response.cursor.seq);
  });

  it("no fixture carries a payee key in the clear", () => {
    const keys = ["financeiro@escola-aurora.example.com.br", "contas@insumos-atlantico.example.com.br", "financeiro@grafica-litoral.example.com.br", "+5511988880006"];
    for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))) {
      const text = readFileSync(join(FIXTURES, name), "utf8");
      for (const key of keys) expect(text.includes(key), `${name} holds ${key}`).toBe(false);
    }
  });
});
