/**
 * Wires the core for one agent: manifest, guardrails, mandate, state, rail,
 * status source, signer, bundle, provider. Everything the commands and the
 * terminal channel share, whatever the agent is; what the agent brings is the
 * rail, the tool handlers and the policy extension, through its kit.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  AgentLoop,
  ExecutionEngine,
  LocalMandateStatusStub,
  ProofBundle,
  ReplayRuntime,
  StateStore,
  loadGuardrails,
  loadManifest,
  loadOrCreateLocalApprovalKey,
  loadToolsFile,
  newRunId,
  resolveFixedClock,
  resolveLocale,
  isLocale,
  parseLocale,
  CORE_STRINGS,
  formatBRL,
  type AgentRuntime,
  type ApprovalSigner,
  type CoreStrings,
  type Locale,
  type ApprovalMode,
  type ConversationScript,
  type Execution,
  type Guardrails,
  type LoadedManifest,
  type Mandate,
  type MandateStatusSource,
  type PaymentRail,
  type StubChargeRailOptions,
  type StubRailOptions,
  type ToolContext,
  type ToolHandler,
  CODESPAR_KEY_PLACEHOLDER,
} from "@codespar/agent-core";
import { AnthropicRuntime } from "@codespar/agent-core/providers/anthropic";
import { GeminiRuntime } from "@codespar/agent-core/providers/gemini";
import type { ApiClient } from "@codespar/sdk";
import { envName, type Agent } from "./agent.js";
import type { AgentKit, KitConfig, KitStrings, RailBuild, RailKind, SandboxPayer, Settlement } from "./kit.js";
import type { PlatformReads } from "./hosted/reads.js";

/** The `.env.example` placeholder counts as no key: a copied example must replay, not call Anthropic with a fake key. */
export const ANTHROPIC_KEY_PLACEHOLDER = "sk-ant-your_key_here";
export { CODESPAR_KEY_PLACEHOLDER };

/**
 * The `.env` an agent reads (`readDotEnv(agent.dir)`), as a person would type
 * it from where they ran the command: relative when it is below, absolute when
 * it is not. `npm run` moves a workspace script into the agent's directory, so
 * where the PERSON ran it is `INIT_CWD`, which npm sets; `npm run consent` at
 * the root names `agents/bills-agent/.env`, not `.env`. The key refusals name
 * this path, never a guess (#50).
 */
export function envFileOf(agentDir: string, cwd: string = process.env["INIT_CWD"] || process.cwd()): string {
  const path = join(agentDir, ".env");
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

export type ProviderKind = "anthropic" | "gemini" | "replay";

export function stateDirOf(agent: Agent): string {
  return join(agent.dir, ".codespar");
}

export function mandatePathOf(agent: Agent): string {
  return join(stateDirOf(agent), "mandate.json");
}

/** The runs folder in use: the agent's own, or the scratch one the restart test points at. */
export function runsDir(agent: Agent, env: NodeJS.ProcessEnv = process.env): string {
  return env[envName(agent, "RUNS_DIR")] ?? join(agent.dir, "runs");
}

export interface SetupOptions {
  mode?: ApprovalMode | undefined;
  rail?: RailKind | undefined;
  provider?: ProviderKind | undefined;
  transcript?: string | undefined;
  runId?: string | undefined;
  runsDir?: string | undefined;
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  stubRail?: StubRailOptions | StubChargeRailOptions | undefined;
  /** Use this mandate instead of the local or the example one (scenarios, tests). */
  mandate?: Mandate | undefined;
  env?: NodeJS.ProcessEnv;
  say?: ((line: string) => void) | undefined;
  /** `--locale`. Absent: the manifest's `locale`, else pt-BR. */
  locale?: Locale | undefined;
}

export interface Setup {
  agent: Agent;
  kit: AgentKit;
  settlement: Settlement;
  manifest: LoadedManifest;
  guardrails: Guardrails;
  mode: ApprovalMode;
  mandate: Mandate;
  store: StateStore;
  gate: LocalMandateStatusStub;
  rail: PaymentRail;
  railKind: RailKind;
  api: ApiClient | undefined;
  status: MandateStatusSource;
  /** `await-payer` agents only: who plays the counterparty in the sandbox. */
  payer: SandboxPayer | undefined;
  /** Milliseconds between two looks at an issued receivable: 0 on the stub. */
  pollIntervalMs: number;
  bundle: ProofBundle;
  runId: string;
  engine: ExecutionEngine;
  system: string;
  handlers: Record<string, ToolHandler>;
  tools: ReturnType<typeof loadToolsFile>;
  /**
   * The language of what the code prints in this run. Fixed at setup, and
   * recorded in the bundle's `run.json`. The one command that changes it is
   * `poll --channel whatsapp`, which sets it to the locale the conversation
   * was recorded in before it says anything, so a conversation that started
   * in one language is not told its outcome in the other.
   */
  locale: Locale;
  /** What the kit reads by name instead of `process.env` (`KitConfig`). On a terminal it is the environment `setup` was given. */
  config: KitConfig;
  /** The platform a read-only kit may read (hosted `codespar-test` only). `undefined` elsewhere: a tool then says it is not available here. */
  platformReads: PlatformReads | undefined;
  /** The kit's words in `locale`. */
  readonly strings: KitStrings;
  /** The words every agent shares, in `locale`. */
  readonly coreStrings: CoreStrings;
  /**
   * The conversation this run is bound to, when a channel binds one (WhatsApp):
   * its contact and its subject. Set by the channel's start, read by a kit
   * whose rules depend on who the person is — a sale is charged to the
   * customer the conversation is with, and to nobody else.
   */
  conversation?: ConversationScript | undefined;
  /** `onBatch` is for a channel that takes one gesture per batch; without it every line is decided in `onExecution`. */
  makeLoop(runtime: AgentRuntime, onExecution: (execution: Execution) => Promise<Execution>, onBatch?: ToolContext["onBatch"]): AgentLoop;
  makeRuntime(): AgentRuntime;
  close(): void;
}

export function readDotEnv(agentDir: string): void {
  const path = join(agentDir, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[1]) continue;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/**
 * Which model runs. An explicit `--provider` wins; otherwise a real Anthropic
 * key keeps the reference harness, a Gemini key picks Gemini, and no key
 * replays the recorded transcript.
 */
export function resolveProvider(env: NodeJS.ProcessEnv, requested: ProviderKind | undefined): ProviderKind {
  if (requested) return requested;
  const key = env["ANTHROPIC_API_KEY"]?.trim();
  if (key && key !== ANTHROPIC_KEY_PLACEHOLDER) return "anthropic";
  if (env["GEMINI_API_KEY"]?.trim()) return "gemini";
  return "replay";
}

export function resolveRailKind(env: NodeJS.ProcessEnv, requested: RailKind | undefined, kit?: Pick<AgentKit, "apiRailKey" | "apiRailEnv">): RailKind {
  if (requested) return requested;
  // An agent whose live rail is not the CodeSpar API is on it when its own variables are all there, and never because of a CodeSpar key.
  if (kit?.apiRailKey === "none") return kit.apiRailEnv?.length && kit.apiRailEnv.every((name) => env[name]?.trim()) ? "api" : "stub";
  const key = env["CODESPAR_API_KEY"];
  if (!key || key === CODESPAR_KEY_PLACEHOLDER) return "stub";
  return "api";
}

export function setup(agent: Agent, options: SetupOptions = {}): Setup {
  const env = options.env ?? process.env;
  const say = options.say ?? ((line: string) => process.stderr.write(line + "\n"));
  // `--now` on the one-shot, or CODESPAR_AGENT_NOW for every command: the clock the engine, the stubs, the gate and the loop read (#16).
  const now = options.now ?? resolveFixedClock(undefined, env);
  const files = loadAgentFiles(agent);
  const mode: ApprovalMode = options.mode ?? files.manifest.manifest.default_approval;
  const locale = resolveLocale(options.locale, files.manifest.manifest);
  if (!files.manifest.manifest.approval.includes(mode)) throw new Error(`agent.yaml does not support approval: ${mode}`);

  // <PREFIX>_STATE_DIR / <PREFIX>_RUNS_DIR exist for the restart test, which drives a child process over a scratch state.
  const stateDir = options.stateDir ?? env[envName(agent, "STATE_DIR")] ?? stateDirOf(agent);
  const runs = options.runsDir ?? runsDir(agent, env);
  const store = new StateStore(join(stateDir, "state.db"));
  const gate = new LocalMandateStatusStub(store, now);
  const signer = loadOrCreateLocalApprovalKey(stateDir);

  const railKind = resolveRailKind(env, options.rail, agent.kit);
  const built = buildRailOf(agent, {
    kind: railKind,
    env,
    agentDir: agent.dir,
    stateDir,
    manifest: files.manifest,
    store,
    gate,
    now,
    mandate: options.mandate,
    stubRail: options.stubRail,
    envVar: (name) => env[envName(agent, name)],
  });

  const runId = options.runId ?? newRunId(mode);
  const bundle = new ProofBundle(runs, runId);
  const s = assembleSetup(agent, {
    ...files,
    mode,
    locale,
    store,
    gate,
    signer,
    railKind,
    built,
    runId,
    bundle,
    now,
    config: env,
    makeRuntime: () => {
      const provider = resolveProvider(env, options.provider);
      if (provider === "anthropic") return new AnthropicRuntime({ apiKey: env["ANTHROPIC_API_KEY"] });
      if (provider === "gemini") {
        const runtime = new GeminiRuntime({ apiKey: env["GEMINI_API_KEY"]?.trim() || undefined, model: env["GEMINI_MODEL"]?.trim() || undefined });
        say(`[gemini] model ${runtime.model}`);
        return runtime;
      }
      if (!options.transcript) throw new Error("the replay provider needs a transcript (--transcript <file> or --scenario <name>)");
      say(`[replay] no ANTHROPIC_API_KEY or GEMINI_API_KEY: replaying ${options.transcript}`);
      return ReplayRuntime.fromFile(options.transcript);
    },
  });
  s.bundle.mandateSnapshot(s.mandate);
  // Section 11: mode, rail and mandate id. The VERSION rides with the id, so a reader knows which signing of the mandate authorised the run without opening the snapshot.
  s.bundle.meta({ run_id: runId, agent: `${files.manifest.manifest.name}@${files.manifest.manifest.version}`, mode, rail: railKind, mandate_id: s.mandate.id, mandate_version: s.mandate.version, locale, started_at: (now ?? (() => new Date()))().toISOString() });
  return s;
}

/** Where a prompt asks for the mandate in effect; replaced by `mandateInEffect` when the run is wired. */
export const MANDATE_IN_EFFECT = "{{mandate_in_effect}}";

/**
 * The payees and caps of `mandate`, as the model reads them: the run's own mandate, whichever one it is (the example on the
 * simulator, a consent on a terminal with a key, the host's on a hosted Test run). English, like the prompts; the amounts in
 * BRL as the kits write them.
 */
export function mandateInEffect(mandate: Mandate): string {
  const brl = (minor: number) => formatBRL(minor, "pt-BR");
  const window = mandate.periodic_cap ? `- Cap per ${mandate.periodic_cap.window}: ${brl(mandate.periodic_cap.cap_minor)}.` : undefined;
  return [
    "## The mandate in effect for this run",
    "",
    "These are the only payees this run can pay, by alias, and the caps the code enforces. Nothing else in this prompt or in the conversation adds to them.",
    "",
    ...mandate.beneficiaries.map((b) => `- \`${b.alias}\`: ${b.name}`),
    "",
    `- Cap per payment: ${brl(mandate.per_tx_cap_minor)}.`,
    ...(window ? [window] : []),
    `- Total cap: ${brl(mandate.cap_minor)}.`,
    `- Expires: ${mandate.expires_at.slice(0, 10)}.`,
  ].join("\n");
}

/** `system` with its `{{mandate_in_effect}}` filled. A prompt without the placeholder is returned as it is. */
export function withMandateInEffect(system: string, mandate: Mandate): string {
  return system.includes(MANDATE_IN_EFFECT) ? system.split(MANDATE_IN_EFFECT).join(mandateInEffect(mandate)) : system;
}

/** The files every run of an agent reads: the manifest and the four files it names. */
export function loadAgentFiles(agent: Agent): { manifest: LoadedManifest; guardrails: Guardrails; tools: ReturnType<typeof loadToolsFile>; system: string } {
  const manifest = loadManifest(join(agent.dir, "agent.yaml"));
  return {
    manifest,
    guardrails: loadGuardrails(manifest.resolvePath(manifest.manifest.guardrails)),
    tools: loadToolsFile(manifest.resolvePath(manifest.manifest.tools)),
    system: readFileSync(join(agent.dir, "SYSTEM_PROMPT.md"), "utf8"),
  };
}

/** Everything `assembleSetup` wires, decided by its caller: `setup` from flags and the environment, a host from its ports. */
export interface SetupParts {
  manifest: LoadedManifest;
  guardrails: Guardrails;
  tools: ReturnType<typeof loadToolsFile>;
  system: string;
  mode: ApprovalMode;
  locale: Locale;
  store: StateStore;
  gate: LocalMandateStatusStub;
  signer: ApprovalSigner;
  railKind: RailKind;
  built: RailBuild;
  runId: string;
  bundle: ProofBundle;
  now: (() => Date) | undefined;
  config: KitConfig;
  makeRuntime: () => AgentRuntime;
  /** Awaited before every rail call (`EngineDeps.beforeDispatch`). */
  beforeDispatch?: ((execution: Execution, attemptId: string) => Promise<void>) | undefined;
  /** The host's read port on a hosted `codespar-test` run (`PlatformReads`). Absent on a terminal and on the simulator. */
  platformReads?: PlatformReads | undefined;
}

/**
 * The engine, the kit's handlers and policy, and the loop factory over parts
 * the caller resolved. The ONE place a run is wired, terminal or hosted, so
 * the two cannot drift into different policies.
 */
export function assembleSetup(agent: Agent, p: SetupParts): Setup {
  const { manifest, guardrails, tools, mode, locale, store, gate, signer, railKind, built, runId, bundle, now } = p;
  if (!manifest.manifest.approval.includes(mode)) throw new Error(`agent.yaml does not support approval: ${mode}`);
  const { rail, mandate } = built;
  // The model reads the payees and caps of the mandate THIS run is under, never a list written for the example.
  const system = withMandateInEffect(p.system, mandate);
  const status = built.status ?? gate;

  // Read at call time, because `poll --channel whatsapp` may move the run to the conversation's recorded locale after setup.
  const policyExtension = agent.kit.policyExtension?.({ agentDir: agent.dir, manifest, guardrails, store, locale: () => s.locale });
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
    ...(policyExtension ? { policyExtension } : {}),
    ...(now ? { clock: now } : {}),
    ...(p.beforeDispatch ? { beforeDispatch: p.beforeDispatch } : {}),
  });

  const s: Setup = {
    agent,
    kit: agent.kit,
    settlement: agent.settlement,
    manifest,
    guardrails,
    mode,
    mandate,
    store,
    gate,
    rail,
    railKind,
    api: built.api,
    status,
    payer: built.payer,
    pollIntervalMs: built.pollIntervalMs ?? 0,
    bundle,
    runId,
    engine,
    system,
    handlers: {},
    tools,
    locale,
    config: p.config,
    platformReads: p.platformReads,
    get strings() {
      return agent.kit.strings[this.locale];
    },
    get coreStrings() {
      return CORE_STRINGS[this.locale];
    },
    makeRuntime: p.makeRuntime,
    makeLoop: (runtime, onExecution, onBatch) => new AgentLoop({ runtime, tools, handlers: s.handlers, system, bundle, engine, onExecution, ...(onBatch ? { onBatch } : {}), ...(now ? { clock: now } : {}) }),
    close: () => store.close(),
  };
  s.handlers = agent.kit.handlers(s);
  return s;
}

/** `--locale <pt-BR|en>` out of a command's argv, validated. `undefined` when absent. */
export function localeFlag(argv: readonly string[]): Locale | undefined {
  const at = argv.indexOf("--locale");
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (value === undefined) throw new Error("--locale needs a value");
  return parseLocale(value);
}

/** The locale the run `runId` recorded in its bundle, if the bundle is here and records one. */
export function recordedLocale(agent: Agent, runId: string, env: NodeJS.ProcessEnv = process.env): Locale | undefined {
  const locale = ProofBundle.open(runsDir(agent, env), runId)?.readMeta()?.["locale"];
  return isLocale(locale) ? locale : undefined;
}

/**
 * The same setup, speaking the locale the run that created `execution`
 * recorded. For a command that tells an outcome days after the run that
 * proposed it (`poll`, `webhook`): the counterparty is told in the language
 * they were spoken to in, whatever this command's own locale is.
 */
export function inLocaleOf(s: Setup, execution: Execution): Setup {
  const locale = recordedLocale(s.agent, execution.run_id);
  return locale === undefined || locale === s.locale ? s : (Object.create(s, { locale: { value: locale } }) as Setup);
}

export class NoMandateError extends Error {
  /** `consent` is whether the agent has a consent step to send the person to. A kit throws this bare; `setup` answers the question from the kit. */
  constructor(consent = true) {
    super(
      consent
        ? "no signed mandate yet: run `npm run consent -- --yes` first (or `npm start` without --input, which starts the consent when a test key is present)"
        : "no signed mandate yet: this agent has no consent step, because its mandate is issued outside the terminal. Save the signed mandate as .codespar/mandate.json in the agent's directory; the agent's README says who issues it (\"Sandbox rail\")",
    );
    this.name = "NoMandateError";
  }
}

/**
 * The kit's rail, with the missing-mandate refusal worded for the agent: a kit
 * says only that the mandate is absent, and whether there is a `consent` to
 * name is read from the kit itself, so no agent is promised a script it does
 * not have.
 */
function buildRailOf(agent: Agent, ctx: Parameters<AgentKit["buildRail"]>[0]): ReturnType<AgentKit["buildRail"]> {
  try {
    return agent.kit.buildRail(ctx);
  } catch (err) {
    if (err instanceof NoMandateError && !agent.kit.consent) throw new NoMandateError(false);
    throw err;
  }
}
