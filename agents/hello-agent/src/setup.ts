/**
 * Wires the core for this agent: manifest, guardrails, mandate, state,
 * rail, status source, signer, bundle, provider. Everything the commands
 * and the terminal channel share.
 *
 * Read-only kind: there is no API rail and no consent. The rail is always
 * the stub and the mandate is always `mandate.example.json`; the engine
 * exists because the runner and the section 9 `events` case drive it, and
 * because a tool handler that could draft would need it. None here can.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalMandateStatusStub,
  AgentLoop,
  ExecutionEngine,
  ProofBundle,
  ReplayRuntime,
  StateStore,
  StubRail,
  loadGuardrails,
  loadManifest,
  loadMandate,
  loadOrCreateLocalApprovalKey,
  loadToolsFile,
  newRunId,
  type AgentRuntime,
  type ApprovalMode,
  type Execution,
  type LoadedManifest,
  type Mandate,
  type MandateStatusSource,
  type PaymentRail,
  type StubRailOptions,
  type ToolHandler,
} from "@codespar/agent-core";
import { AnthropicRuntime } from "@codespar/agent-core/providers/anthropic";
import { listBills } from "./modules/bills-read.js";

export const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = join(AGENT_DIR, ".codespar");
export const RUNS_DIR = join(AGENT_DIR, "runs");

/** The runs folder in use: the agent's own, or the scratch one the tests point at. */
export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["HELLO_RUNS_DIR"] ?? RUNS_DIR;
}

export type RailKind = "stub";

export interface SetupOptions {
  mode?: ApprovalMode | undefined;
  rail?: RailKind | undefined;
  provider?: ProviderKind | undefined;
  transcript?: string | undefined;
  runId?: string | undefined;
  runsDir?: string | undefined;
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  stubRail?: StubRailOptions | undefined;
  mandate?: Mandate | undefined;
  env?: NodeJS.ProcessEnv;
  say?: ((line: string) => void) | undefined;
}

export interface Setup {
  manifest: LoadedManifest;
  mode: ApprovalMode;
  mandate: Mandate;
  store: StateStore;
  gate: LocalMandateStatusStub;
  rail: PaymentRail;
  railKind: RailKind;
  status: MandateStatusSource;
  bundle: ProofBundle;
  runId: string;
  engine: ExecutionEngine;
  system: string;
  handlers: Record<string, ToolHandler>;
  tools: ReturnType<typeof loadToolsFile>;
  makeLoop(runtime: AgentRuntime, onExecution: (execution: Execution) => Promise<Execution>): AgentLoop;
  makeRuntime(): AgentRuntime;
  close(): void;
}

export function readDotEnv(agentDir = AGENT_DIR): void {
  const path = join(agentDir, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[1]) continue;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export type ProviderKind = "anthropic" | "replay";

/** The `.env.example` placeholder counts as no key: a copied example must replay, not call Anthropic with a fake key. */
export const ANTHROPIC_KEY_PLACEHOLDER = "sk-ant-your_key_here";

export function resolveProvider(env: NodeJS.ProcessEnv, requested: ProviderKind | undefined): ProviderKind {
  if (requested) return requested;
  const key = env["ANTHROPIC_API_KEY"]?.trim();
  return key && key !== ANTHROPIC_KEY_PLACEHOLDER ? "anthropic" : "replay";
}

export function setup(options: SetupOptions = {}): Setup {
  const env = options.env ?? process.env;
  const say = options.say ?? ((line: string) => process.stderr.write(line + "\n"));
  const manifest = loadManifest(join(AGENT_DIR, "agent.yaml"));
  const guardrails = loadGuardrails(manifest.resolvePath(manifest.manifest.guardrails));
  const tools = loadToolsFile(manifest.resolvePath(manifest.manifest.tools));
  const system = readFileSync(join(AGENT_DIR, "SYSTEM_PROMPT.md"), "utf8");
  const mode: ApprovalMode = options.mode ?? manifest.manifest.default_approval;
  if (!manifest.manifest.approval.includes(mode)) throw new Error(`agent.yaml does not support approval: ${mode}`);

  // HELLO_STATE_DIR / HELLO_RUNS_DIR exist for the tests, which drive a child process over a scratch state.
  const stateDir = options.stateDir ?? env["HELLO_STATE_DIR"] ?? STATE_DIR;
  const runs = options.runsDir ?? runsDir(env);
  const store = new StateStore(join(stateDir, "state.db"));
  const gate = new LocalMandateStatusStub(store, options.now);
  const signer = loadOrCreateLocalApprovalKey(stateDir);

  const rail: PaymentRail = new StubRail(store, { ...(options.now ? { clock: options.now } : {}), ...(options.stubRail ?? {}) });
  const status: MandateStatusSource = gate;
  const mandate = options.mandate ?? loadMandate(manifest.resolvePath(manifest.manifest.mandate_schema));

  const runId = options.runId ?? newRunId(mode);
  const bundle = new ProofBundle(runs, runId);
  bundle.mandateSnapshot(mandate);
  bundle.meta({ run_id: runId, agent: `${manifest.manifest.name}@${manifest.manifest.version}`, mode, rail: "stub", mandate_id: mandate.id, started_at: (options.now ?? (() => new Date()))().toISOString() });

  const engine = new ExecutionEngine({
    store,
    rail,
    status,
    signer,
    manifest: manifest.manifest,
    guardrails: { ...guardrails, approval: mode },
    mandate,
    bundle,
    mode,
    runId,
    onBehalfOf: mandate.consumer_id,
    ...(options.now ? { clock: options.now } : {}),
  });

  const handlers: Record<string, ToolHandler> = { list_bills: listBills };

  const makeRuntime = (): AgentRuntime => {
    const provider = resolveProvider(env, options.provider);
    if (provider === "anthropic") return new AnthropicRuntime({ apiKey: env["ANTHROPIC_API_KEY"] });
    if (!options.transcript) throw new Error("the replay provider needs a transcript (--transcript <file> or --scenario <name>)");
    say(`[replay] no ANTHROPIC_API_KEY: replaying ${options.transcript}`);
    return ReplayRuntime.fromFile(options.transcript);
  };

  return {
    manifest,
    mode,
    mandate,
    store,
    gate,
    rail,
    railKind: "stub",
    status,
    bundle,
    runId,
    engine,
    system,
    handlers,
    tools,
    makeRuntime,
    makeLoop: (runtime, onExecution) => new AgentLoop({ runtime, tools, handlers, system, bundle, engine, onExecution, ...(options.now ? { clock: options.now } : {}) }),
    close: () => store.close(),
  };
}
