/**
 * The deploy-time catalog: one `HostedKitDescriptor` per agent, derived from
 * what the agent already declares — `agent.yaml`, `tools.json`, its scenario
 * packs and its kit module — and from nothing else. There is no list of kit
 * names here and no field a person types: a new agent is in the catalog the
 * day its directory lands, and a field that cannot be derived is a field the
 * kit declares (`kit.hosted`) and this file validates.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { canonicalJson, loadManifest, loadToolsFile, type LoadedManifest, type ToolsFile } from "@codespar/agent-core";
import { loadAgent, type Agent } from "../agent.js";
import { listScenarios, loadScenario } from "../scenarios.js";
import {
  CONTRACT_VERSION,
  HostedCatalogSchema,
  HostedKitDescriptorSchema,
  type EvidenceKind,
  type ExecutorId,
  type HostedCatalog,
  type HostedKitDescriptor,
  type OutcomeKind,
  type PlatformPrerequisite,
} from "./contract.js";

export const REPOSITORY = "codespar/agent-starter-kits" as const;
export const TURN_MAX_LENGTH = 4000;

/** Paths below a kit's directory that never travel: local state, runs, tests, evals and anything installed. */
const NOT_SHIPPED = new Set(["node_modules", ".codespar", "runs", "test", "evals", ".env"]);

/**
 * `sha256:` over the sorted list of `{ path, sha256 }` of every file under
 * `dirs` (relative to `root`), canonical JSON. The same function hashes the
 * source tree here and the laid-out artifact at build time; only the
 * directories differ.
 */
export function treeDigest(root: string, dirs: readonly string[]): string {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (NOT_SHIPPED.has(entry.name) || entry.name.startsWith(".env")) continue;
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ path: relative(root, path).split(sep).join("/"), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    }
  };
  for (const dir of dirs) {
    const abs = resolve(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`treeDigest: ${dir} is not a directory under ${root}`);
    walk(abs);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `sha256:${createHash("sha256").update(canonicalJson(files)).digest("hex")}`;
}

export interface CatalogSource {
  /** The repository root the paths are relative to. */
  root: string;
  /** `git rev-parse HEAD` of `root`, in full. */
  commit: string;
  /** The runtime trees every kit's digest also covers, relative to `root`: a change to the runner changes every kit. */
  shared: readonly string[];
  /** The digest of a kit as it ships, when that is not the source tree: the artifact builder hashes the laid-out package. */
  digestOf?: ((id: string) => string) | undefined;
}

function toolList(tools: ToolsFile): HostedKitDescriptor["tools"] {
  return [...tools.meta_tools, ...tools.local_tools].map((t) => ({ name: t.name, effect: t.effect }));
}

/** The descriptor of one agent. Throws when the agent contradicts the contract; `describeKit` never repairs one. */
export function describeKit(agent: Agent, source: CatalogSource): HostedKitDescriptor {
  const loaded = loadManifest(join(agent.dir, "agent.yaml"));
  const m = loaded.manifest;
  const tools = toolList(loadToolsFile(loaded.resolvePath(m.tools)));
  const effects = new Set(tools.map((t) => t.effect));
  const moves = effects.has("payment") || effects.has("charge");
  const maturity = m.maturity;

  const words = m.presentation;
  const examples = listScenarios(agent).map((name) => {
    const scenario = loadScenario(agent, name);
    const pt = words?.["pt-BR"].examples[name];
    const en = words?.en.examples[name];
    if (words && (!pt || !en)) throw new Error(`${m.name}: presentation has no words for example ${name} in ${!pt ? "pt-BR" : "en"}`);
    return {
      id: scenario.name,
      description: scenario.description,
      approvalModes: scenario.modes,
      turns: scenario.turns.map((t) => ({ input: t.input })) as [{ input: string }, ...Array<{ input: string }>],
      replay: existsSync(resolve(agent.dir, "scenarios", scenario.transcript)),
      presentation: pt && en ? { "pt-BR": { title: pt.title, description: pt.description }, en: { title: en.title, description: en.description } } : null,
    };
  });
  if (words) {
    const names = new Set(examples.map((e) => e.id));
    for (const locale of ["pt-BR", "en"] as const) for (const named of Object.keys(words[locale].examples)) if (!names.has(named)) throw new Error(`${m.name}: presentation (${locale}) names ${named}, which is not a scenario pack`);
    for (const recommended of recommendationsOf(words)) {
      if (!examples.some((e) => e.id === recommended.example && e.replay)) throw new Error(`${m.name}: presentation.recommended names ${recommended.example}, which is not a scenario pack with a recorded transcript`);
    }
  }

  // The executors: the kit's own stub always. `codespar-test` for a kit whose money moves on the CodeSpar API: there the kit
  // drafts a platform proposal per attempt and a person pays it (CONTRATO.md v1.1); a kit on another rail has none.
  const receiptBlocked = maturity["receipt-verification"] === "blocked";
  const executors: HostedKitDescriptor["executors"] = [{ id: "simulator", evidence: moves ? "simulated" : "none", requires: [], blockedBy: [] }];
  if (moves && agent.kit.apiRailKey !== "none") {
    const evidence: EvidenceKind = effects.has("payment") && !receiptBlocked ? "codespar_receipt" : "charge_status";
    const requires: PlatformPrerequisite[] = ["platform.test_project", "platform.consumer_mandate"];
    if (effects.has("payment")) requires.push("platform.payouts");
    if (effects.has("charge")) requires.push("platform.charges");
    const blockedBy = [
      ...Object.entries(maturity)
        .filter(([capability, level]) => level === "blocked" && capability !== "receipt-verification")
        .map(([capability]) => capability),
      // The platform drafts payment proposals; it has no governed route that drafts a charge for a person to issue. Not invented here.
      ...(effects.has("charge") ? ["platform.charge_proposals"] : []),
    ].sort();
    executors.push({ id: "codespar-test" satisfies ExecutorId, evidence, requires, blockedBy });
  }

  const derived: OutcomeKind[] = ["answer", ...(effects.has("payment") ? (["payment"] as const) : []), ...(effects.has("charge") ? (["charge"] as const) : [])];
  const outcomeKinds = agent.kit.hosted?.outcomeKinds ? [...agent.kit.hosted.outcomeKinds] : derived;

  const exampleIds = examples.map((e) => e.id);
  const descriptor: HostedKitDescriptor = {
    id: m.name,
    version: m.version,
    contractVersion: CONTRACT_VERSION,
    source: { repository: REPOSITORY, commit: source.commit, packageDigest: source.digestOf ? source.digestOf(m.name) : treeDigest(source.root, [relative(source.root, agent.dir), ...source.shared]) },
    entrypoint: `kits/${m.name}/src/kit.js`,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        approvalMode: { enum: m.approval, default: m.default_approval },
        locale: { enum: ["pt-BR", "en"], default: m.locale ?? "pt-BR" },
        ...(exampleIds.length > 0 ? { exampleId: { enum: exampleIds } } : {}),
      },
    },
    turnSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: TURN_MAX_LENGTH } },
    },
    requiredCapabilities: Object.keys(maturity).sort(),
    capabilityMaturity: maturity,
    supportedModelModes: examples.some((e) => e.replay) ? ["replay", "model"] : ["model"],
    supportedExecutors: executors.map((e) => e.id) as [ExecutorId, ...ExecutorId[]],
    executors: executors as HostedKitDescriptor["executors"],
    outcomeKinds: outcomeKinds as [OutcomeKind, ...OutcomeKind[]],
    settlement: moves ? agent.settlement : "none",
    needsMandate: moves,
    approvalModes: m.approval,
    defaultApprovalMode: m.default_approval,
    tools,
    locales: ["pt-BR", "en"],
    defaultLocale: m.locale ?? "pt-BR",
    presentation: words ? { "pt-BR": { title: words["pt-BR"].title, summary: words["pt-BR"].summary }, en: { title: words.en.title, summary: words.en.summary } } : null,
    recommended: (() => {
      const pick = recommendationsOf(words).find((r) => r.executor === "simulator");
      return pick ? { example: pick.example, rank: pick.rank } : null;
    })(),
    recommendations: recommendationsOf(words),
    exampleIds,
    examples,
  };
  checkDeclaredOutcomes(descriptor, effects);
  return HostedKitDescriptorSchema.parse(descriptor);
}

/** What a kit may declare beyond its tool effects: `order` rides a charge, `pull` replaces it. Nothing may claim money a tool cannot move. */
function checkDeclaredOutcomes(d: HostedKitDescriptor, effects: Set<string>): void {
  for (const kind of d.outcomeKinds) {
    const ok = kind === "answer" || (kind === "payment" && effects.has("payment")) || ((kind === "charge" || kind === "order" || kind === "pull") && effects.has("charge"));
    if (!ok) throw new Error(`${d.id}: outcome kind ${kind} is not backed by any tool in tools.json`);
  }
}

/** The manifest's recommendations as a list, each with its rank (default 1) and executor (default the simulator). */
function recommendationsOf(words: LoadedManifest["manifest"]["presentation"]): Array<{ example: string; rank: number; executor: ExecutorId }> {
  const declared = words?.recommended;
  if (!declared) return [];
  return (Array.isArray(declared) ? declared : [declared]).map((r) => ({ example: r.example, rank: r.rank ?? 1, executor: r.executor ?? "simulator" }));
}

/** Every directory under `agentsDir` that holds an `agent.yaml`, sorted. */
export function discoverAgentDirs(agentsDir: string): string[] {
  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(agentsDir, e.name, "agent.yaml")))
    .map((e) => join(agentsDir, e.name))
    .sort();
}

export async function buildCatalog(source: CatalogSource, agentDirs: readonly string[], artifactVersion: string): Promise<HostedCatalog> {
  const kits: HostedKitDescriptor[] = [];
  for (const dir of agentDirs) kits.push(describeKit(await loadAgent(dir), source));
  kits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return HostedCatalogSchema.parse({ v: 1, contractVersion: CONTRACT_VERSION, artifact: { name: "@codespar/hosted-kits", version: artifactVersion, commit: source.commit }, kits });
}
