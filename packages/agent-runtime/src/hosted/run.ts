/**
 * The hosted channel: the same kit, engine and channel logic a terminal runs,
 * driven by a host's commands instead of a keyboard (CONTRATO.md v1).
 *
 * What changes from the terminal is only what a host cannot infer and must
 * supply through its ports: who is acting (`identity`), where the run's state
 * lives between commands (`state`), who may approve and with which key
 * (`approval`), which executor the run is pinned to (`rail`), which model mode
 * (`model`) and which configuration the kit may read (`config`). Nothing here
 * decides about money: every decision is `ExecutionEngine`'s, through the
 * terminal's own `handleExecution` and `decideByGesture`.
 *
 * Three things a terminal does that a hosted run never does: it never waits
 * for a person inside a turn (an execution awaiting approval is left awaiting
 * and decided by a later `decide`), it never writes a file (the store is in
 * memory and the bundle is a map, both saved through `state`), and it never
 * picks an approver, a rail or a model by default.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  AgentLoop,
  LocalMandateStatusStub,
  MemoryFiles,
  ProofBundle,
  ReplayExhaustedError,
  ReplayRuntime,
  StateStore,
  canonicalJson,
  isTerminal,
  loadMandate,
  maskPayee,
  newRunId,
  redactorFor,
  type Actor,
  type AgentRuntime,
  type ApprovalSigner,
  type BatchPresentation,
  type ConversationMessage,
  type EventRow,
  type Execution,
  type ExecutionState,
  type Mandate,
  type ReplyLanguage,
  type StoreImage,
  type ToolCall,
  type TransitionRecord,
} from "@codespar/agent-core";
import { envName, type Agent } from "../agent.js";
import type { KitConfig, RailBuild, RailKind } from "../kit.js";
import { isAwaitingPayer } from "../poll.js";
import { loadScenario } from "../scenarios.js";
import { ProposalPaymentRail, type ProposalRail } from "./proposals.js";
import { assembleSetup, loadAgentFiles, type Setup } from "../setup.js";
import { decideByGesture, followUp, handleExecution, type BatchGestureRecord } from "../terminal.js";
import { RUN_ID } from "./contract.js";
import type {
  ActorView,
  ApprovalBinding,
  BatchView,
  EvidenceKind,
  EvidenceRef,
  ExecutionView,
  ExecutorId,
  HostedEvent,
  HostedEventType,
  HostedKitDescriptor,
  ModelMode,
  PendingAction,
  RunSnapshot,
} from "./contract.js";

// ---- ports ---------------------------------------------------------------

export interface HostedActor {
  userId: string;
  orgId: string;
  projectId: string;
  environment: "test";
}

/** Who is acting, resolved by the host for every command. */
export interface IdentityPort {
  actor(): Promise<HostedActor>;
}

/** The run's durable record. `save` is compare-and-set on `revision` (0: the run does not exist yet) and writes the image and its new events together. */
export interface StatePort {
  load(runId: string): Promise<{ image: RunImage; revision: number } | undefined>;
  /** `binding_changed`: the host already holds another binding for an execution this save asks approval for; nothing of the save was kept. */
  save(runId: string, image: RunImage, newEvents: readonly HostedEvent[], expectedRevision: number): Promise<{ ok: true; revision: number } | { ok: false; reason: "revision_conflict" | "binding_changed" }>;
  events(runId: string, after: number): Promise<HostedEvent[]>;
}

/** Authority over a human decision. Asked before the engine sees the decision; it can only refuse. */
export interface ApprovalPort {
  /** The key approval artifacts are signed with. Held by the host; never a file. */
  signer: ApprovalSigner;
  authorize(request: { runId: string; executionId: string; decision: "approve" | "deny"; binding: ApprovalBinding; actor: HostedActor }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
}

/**
 * The executor, pinned at create. No fallback in either direction.
 * `simulator`: the kit's own stub rail and example mandate, in the run's private store.
 * `codespar-test`: each attempt is a platform proposal drafted through `proposals`; a person pays it, the platform dispatches it.
 * The kit gets no client and no key. `mandate` is the one the host binds the kit's own policy to; absent, the kit's example.
 */
export type RailPort = { executor: "simulator" } | { executor: "codespar-test"; proposals: ProposalRail; mandate?: Mandate };

/** The model mode, pinned at create. `replay` is the example's own recorded transcript; `model` is the host's runtime, under its budgets. */
export type ModelPort = { mode: "replay" } | { mode: "model"; runtime: AgentRuntime };

export interface HostedPorts {
  identity: IdentityPort;
  state: StatePort;
  approval: ApprovalPort;
  rail: RailPort;
  model: ModelPort;
  /** What the kit may read by name. Empty unless the host fills it; never the process environment. */
  config?: KitConfig;
  clock?: () => Date;
  /** The operator's log: the lines a terminal prints to its console. Discarded when absent. */
  log?: (line: string) => void;
}

export interface HostedKit {
  agent: Agent;
  descriptor: HostedKitDescriptor;
}

// ---- the durable image -----------------------------------------------------

export type RunStatus = RunSnapshot["run"]["status"];

interface TurnRecord {
  turnId: string;
  index: number;
  text: string;
  origin: "typed" | "example";
  reply: string | null;
  tools: Array<{ toolCallId: string; name: string; effect: string; refused: boolean }>;
  interrupted: boolean;
}

/** Everything a run is between two commands. Opaque to the host, which stores it as it is. */
export interface RunImage {
  v: 1;
  runId: string;
  kit: { id: string; version: string; commit: string; packageDigest: string };
  binding: { modelMode: ModelMode; executor: ExecutorId; approvalMode: "human" | "mandate"; locale: "pt-BR" | "en"; exampleId: string | null; inputRevision: string };
  owner: { userId: string; orgId: string; projectId: string };
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  seq: number;
  store: StoreImage | null;
  history: ConversationMessage[];
  language: ReplyLanguage | null;
  replayCursor: number | null;
  replayBroken: boolean;
  inflight: { turnId: string; commandId: string; startedAt: string } | null;
  commands: Record<string, { type: string; payloadHash: string; result: unknown }>;
  bundle: Record<string, string>;
  batches: Record<string, { presentation: BatchPresentation; gesture: { batchHash: string; vetoed: number[] } | null }>;
  turns: TurnRecord[];
  notRun: Array<{ ref: string; why: string; detail: string | null }>;
  projected: { storeSeq: number };
  stopped: { at: string; by: string; reason: string | null } | null;
}

// ---- refusals --------------------------------------------------------------

export type HostedRefusalCode =
  | "executor_unsupported"
  | "model_mode_unsupported"
  | "example_unknown"
  | "approval_mode_unsupported"
  | "invalid_command"
  | "digest_mismatch"
  | "command_conflict"
  | "run_unknown"
  | "run_stopped"
  | "revision_conflict"
  | "decision_stale"
  | "decide_on_proposal"
  | "binding_changed"
  | "not_awaiting_approval"
  | "not_awaiting_payer"
  | "not_authorized"
  | "payer_not_simulatable"
  | "replay_exhausted"
  | "replay_requires_example_turn"
  | "turn_failed";

/** A command the run refused. Nothing it would have changed was changed, unless `code` is `turn_failed`, whose partial state is in the snapshot. */
export class HostedRefusal extends Error {
  constructor(
    readonly code: HostedRefusalCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HostedRefusal";
  }
}

// ---- commands --------------------------------------------------------------

export interface CreateCommand {
  commandId: string;
  /** The host's id for the run; generated when absent. */
  runId?: string;
  modelMode: ModelMode;
  executor: ExecutorId;
  options?: { approvalMode?: "human" | "mandate"; locale?: "pt-BR" | "en"; exampleId?: string };
}

export interface RunExport {
  v: 1;
  descriptor: HostedKitDescriptor;
  run: RunSnapshot["run"];
  events: unknown[];
  transcript: unknown[];
  approvals: unknown[];
  receipts: unknown[];
  mandateSnapshot: unknown;
  code: { repository: string; commit: string; kitPath: string; commands: string[] };
}

const INTERRUPTED_TOOL = JSON.stringify({ error: "interrupted", message: "the host restarted while this tool ran; the run state is authoritative" });
const INTERRUPTED_REPLY = "This turn was interrupted by a restart before it finished. What happened is in the run's state; nothing was sent again.";
/** A simulated run has no state directory: the store is in memory and the bundle a map. A kit that tries to write under this path fails loudly. */
const NO_STATE_DIR = "/nonexistent/hosted-run-has-no-state-directory";

const sha256 = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

/** Starts a run. A second `create` with the same `commandId` and `runId` opens the first one instead of starting another. */
export async function createHostedRun(kit: HostedKit, ports: HostedPorts, command: CreateCommand): Promise<HostedRun> {
  const d = kit.descriptor;
  const options = command.options ?? {};
  if (!d.supportedExecutors.includes(command.executor)) throw new HostedRefusal("executor_unsupported", `${d.id} has no ${command.executor} executor`);
  if (ports.rail.executor !== command.executor) throw new HostedRefusal("executor_unsupported", `the host's rail port is ${ports.rail.executor}, the command asks for ${command.executor}`);
  if (!d.supportedModelModes.includes(command.modelMode)) throw new HostedRefusal("model_mode_unsupported", `${d.id} has no ${command.modelMode} mode`);
  if (ports.model.mode !== command.modelMode) throw new HostedRefusal("model_mode_unsupported", `the host's model port is ${ports.model.mode}, the command asks for ${command.modelMode}`);
  const approvalMode = options.approvalMode ?? d.defaultApprovalMode;
  if (!d.approvalModes.includes(approvalMode)) throw new HostedRefusal("approval_mode_unsupported", `${d.id} supports ${d.approvalModes.join(", ")}`);
  const exampleId = options.exampleId ?? null;
  if (exampleId !== null && !d.exampleIds.includes(exampleId)) throw new HostedRefusal("example_unknown", `${d.id} has no example ${exampleId}`);
  if (command.modelMode === "replay" && (exampleId === null || !d.examples.find((e) => e.id === exampleId)?.replay)) throw new HostedRefusal("example_unknown", "a replay needs an example with a recorded transcript");
  const locale = options.locale ?? d.defaultLocale;
  const actor = await ports.identity.actor();
  const runId = command.runId ?? newRunId("hosted");
  if (!RUN_ID.test(runId)) throw new HostedRefusal("invalid_command", `a run id matches ${RUN_ID}`);

  const executor = d.executors.find((e) => e.id === command.executor);
  if (executor && executor.blockedBy.length > 0) throw new HostedRefusal("executor_unsupported", `${d.id} on ${command.executor} is blocked by ${executor.blockedBy.join(", ")}`);
  // Options are immutable per run: the revision is the hash of everything the run was created with.
  const inputRevision = sha256({ kit: d.id, packageDigest: d.source.packageDigest, modelMode: command.modelMode, executor: command.executor, options: { approvalMode, locale, exampleId } });
  const binding = { modelMode: command.modelMode, executor: command.executor, approvalMode, locale, exampleId, inputRevision };
  const existing = await ports.state.load(runId);
  if (existing) {
    const prior = existing.image.commands[command.commandId];
    if (prior?.type === "create" && prior.payloadHash === sha256({ kit: d.id, binding })) return openHostedRun(kit, ports, runId);
    throw new HostedRefusal("command_conflict", `run ${runId} already exists`);
  }

  const now = (ports.clock ?? (() => new Date()))().toISOString();
  const image: RunImage = {
    v: 1,
    runId,
    kit: { id: d.id, version: d.version, commit: d.source.commit, packageDigest: d.source.packageDigest },
    binding,
    owner: { userId: actor.userId, orgId: actor.orgId, projectId: actor.projectId },
    createdAt: now,
    updatedAt: now,
    status: "idle",
    seq: 0,
    store: null,
    history: [],
    language: null,
    replayCursor: command.modelMode === "replay" ? 0 : null,
    replayBroken: false,
    inflight: null,
    commands: { [command.commandId]: { type: "create", payloadHash: sha256({ kit: d.id, binding }), result: { runId } } },
    bundle: {},
    batches: {},
    turns: [],
    notRun: [],
    projected: { storeSeq: 0 },
    stopped: null,
  };
  const run = new HostedRun(kit, ports, image, 0);
  run.start(actor);
  await run.checkpoint();
  return run;
}

/** Reopens a run in this process. A run left mid-turn by a crash is recovered here, before any command reaches it. */
export async function openHostedRun(kit: HostedKit, ports: HostedPorts, runId: string): Promise<HostedRun> {
  const loaded = await ports.state.load(runId);
  if (!loaded) throw new HostedRefusal("run_unknown", runId);
  if (loaded.image.kit.packageDigest !== kit.descriptor.source.packageDigest) throw new HostedRefusal("digest_mismatch", `run ${runId} was created with ${loaded.image.kit.packageDigest}; this kit is ${kit.descriptor.source.packageDigest}`);
  const run = new HostedRun(kit, ports, loaded.image, loaded.revision);
  await run.recover();
  return run;
}

export class HostedRun {
  private readonly setup: Setup;
  private readonly files: MemoryFiles;
  private unsaved: HostedEvent[] = [];
  private loop: AgentLoop | undefined;
  private replay: ReplayRuntime | undefined;
  private approver: { id: string; channel: string } = { id: "", channel: "playground" };
  private currentTurn: string | undefined;
  private currentTool: string | undefined;
  private redact: (value: string | null) => string | null;
  private readonly now: () => Date;
  /** Set when a save failed: this object no longer matches the durable record, and only a reopen may continue the run. */
  private dead: Error | undefined;

  /** Use `createHostedRun` / `openHostedRun`. */
  constructor(
    private readonly kit: HostedKit,
    private readonly ports: HostedPorts,
    private readonly image: RunImage,
    private revision: number,
  ) {
    this.now = ports.clock ?? (() => new Date());
    this.files = new MemoryFiles(new Map(Object.entries(image.bundle)));
    const store = image.store ? StateStore.fromImage(image.store) : new StateStore(":memory:");
    this.setup = this.wire(store);
    this.redact = redactorFor([...this.setup.mandate.beneficiaries.map((b) => b.payee), ...this.setup.mandate.merchant_allowlist]);
  }

  get runId(): string {
    return this.image.runId;
  }

  /** The kit, engine and handlers over this run's own store and bundle. The same `assembleSetup` a terminal run is wired by. */
  private wire(store: StateStore): Setup {
    const agent = this.kit.agent;
    const files = loadAgentFiles(agent);
    const clock = this.ports.clock;
    const gate = new LocalMandateStatusStub(store, clock);
    const config: KitConfig = Object.freeze({ ...(this.ports.config ?? {}) });
    const rail = this.ports.rail;
    let railKind: RailKind;
    let built: RailBuild;
    if (rail.executor === "simulator") {
      railKind = "stub";
      // In the Playground the person plays the counterparty too: the simulated payer acts when they say so (`simulatePayer`), never on its own.
      const stubRail = agent.settlement === "await-payer" ? { payer: "never" as const } : undefined;
      built = agent.kit.buildRail({ kind: "stub", env: config, agentDir: agent.dir, stateDir: NO_STATE_DIR, manifest: files.manifest, store, gate, now: clock, mandate: undefined, stubRail, envVar: (name) => config[envName(agent, name)] });
    } else {
      // The kit's policy runs on the host's mandate (or its own example) and the local status gate; the platform runs its own gate on the proposal.
      railKind = "api";
      built = { rail: new ProposalPaymentRail(rail.proposals, store), mandate: rail.mandate ?? loadMandate(files.manifest.resolvePath(files.manifest.manifest.mandate_schema)) };
    }
    const bundle = ProofBundle.inMemory(this.image.runId, this.files);
    bundle.learnPayees(built.mandate);
    return assembleSetup(agent, {
      ...files,
      mode: this.image.binding.approvalMode,
      locale: this.image.binding.locale,
      store,
      gate,
      signer: this.ports.approval.signer,
      railKind,
      built,
      runId: this.image.runId,
      bundle,
      now: clock,
      config,
      makeRuntime: () => this.runtime(),
      beforeDispatch: () => this.checkpoint(),
    });
  }

  private runtime(): AgentRuntime {
    const model = this.ports.model;
    if (model.mode === "model") return model.runtime;
    const example = this.example();
    if (!example) throw new HostedRefusal("example_unknown", "a replay needs an example");
    this.replay ??= ReplayRuntime.fromFile(resolve(this.kit.agent.dir, "scenarios", loadScenario(this.kit.agent, example.id).transcript), this.image.replayCursor ?? 0);
    return this.replay;
  }

  private example(): HostedKitDescriptor["examples"][number] | undefined {
    const id = this.image.binding.exampleId;
    return id === null ? undefined : this.kit.descriptor.examples.find((e) => e.id === id);
  }

  private loopOf(): AgentLoop {
    if (this.loop) return this.loop;
    const s = this.setup;
    const effects = new Map([...s.tools.meta_tools, ...s.tools.local_tools].map((t) => [t.name, t.effect] as const));
    this.loop = new AgentLoop({
      runtime: s.makeRuntime(),
      tools: s.tools,
      handlers: s.handlers,
      system: s.system,
      bundle: s.bundle,
      engine: s.engine,
      onExecution: (execution) => this.continueExecution(this.forward(execution)),
      onBatch: async (batch) => {
        this.image.batches[batch.ref] = { presentation: batch, gesture: null };
        this.project();
        this.emit("batch.presented", "loop", presentationView(batch), { batchRef: batch.ref, ...this.turnRef() });
        // A hosted run never waits inside a turn: every line is drafted, left awaiting, and decided by one `decide` on the list.
        return undefined;
      },
      ...(this.ports.clock ? { clock: this.ports.clock } : {}),
      history: this.image.history,
      language: this.image.language ?? undefined,
      observer: {
        toolStarted: (call: ToolCall) => {
          this.project();
          this.currentTool = call.id;
          const effect = effects.get(call.name) ?? "read";
          this.turnRecord()?.tools.push({ toolCallId: call.id, name: call.name, effect, refused: false });
          this.emit("tool.started", "loop", { toolCallId: call.id, name: call.name, effect }, { toolCallId: call.id, ...this.turnRef() });
        },
        toolCompleted: (call: ToolCall, result: { refused: boolean; content: unknown }) => {
          this.project();
          const effect = effects.get(call.name) ?? "read";
          const tool = this.turnRecord()?.tools.find((t) => t.toolCallId === call.id);
          if (tool) tool.refused = result.refused;
          const error = result.refused && result.content && typeof result.content === "object" ? String((result.content as Record<string, unknown>)["error"] ?? "refused") : null;
          this.emit("tool.completed", "loop", { toolCallId: call.id, name: call.name, effect, refused: result.refused, error }, { toolCallId: call.id, ...this.turnRef() });
          this.currentTool = undefined;
        },
        stepCompleted: () => this.checkpoint(),
      },
    });
    return this.loop;
  }

  /**
   * codespar-test: the kit's approval is not where the person decides; the platform proposal is. An execution the kit holds for
   * approval is forwarded by the run's actor (channel `platform-proposal`), so the engine runs its last gate and drafts the
   * proposal. The forward authorizes no payment and a blocked execution is still denied by the engine.
   */
  private forward(execution: Execution): Execution {
    if (this.image.binding.executor !== "codespar-test" || execution.state !== "awaiting_approval") return execution;
    this.project();
    const forwarded = this.setup.engine.approve(execution.id, { id: this.approver.id, channel: "platform-proposal" });
    this.decided(forwarded, "forward", "platform-proposal");
    return forwarded;
  }

  /** What the terminal does with an execution a tool or a decision produced, never asking anyone: awaiting stays awaiting; approved runs; a receivable is looked at once. */
  private continueExecution(execution: Execution): Promise<Execution> {
    return handleExecution(execution, {
      setup: this.setup,
      approver: this.approver,
      decision: "none",
      waitSeconds: 0,
      say: (line) => this.ports.log?.(line),
      // The instrument travels as `instrument.presented`, with its copy-and-paste; a console's QR drawing is not a message to anyone.
      presentInstrument: () => {},
      tell: (line, about) => {
        this.project();
        this.emit("counterparty.message", "kit", { text: this.redact(line) ?? "" }, about ? { executionId: about.id } : {});
      },
    });
  }

  // ---- lifecycle ---------------------------------------------------------

  /** First wiring of a new run: the masked mandate and run.json in the bundle, and `run.created`. */
  start(actor: HostedActor): void {
    const s = this.setup;
    s.bundle.mandateSnapshot(s.mandate);
    s.bundle.meta({ run_id: this.image.runId, agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`, mode: s.mode, rail: s.railKind, executor: this.image.binding.executor, model_mode: this.image.binding.modelMode, mandate_id: s.mandate.id, mandate_version: s.mandate.version, locale: s.locale, started_at: this.image.createdAt });
    this.approver = { id: actor.userId, channel: "playground" };
    const { kit, binding } = this.image;
    this.emit("run.created", "host", { kit, modelMode: binding.modelMode, executor: binding.executor, approvalMode: binding.approvalMode, locale: binding.locale, exampleId: binding.exampleId, inputRevision: binding.inputRevision });
  }

  /**
   * A run reopened with a turn in flight was cut by a crash. The turn is not
   * run again and its text is not sent again: each tool call that never got a
   * result gets one saying so, the turn is marked interrupted, open
   * executions are reconciled (never re-sent past an outbox row marked
   * `sent`) and stale approvals expire.
   */
  async recover(): Promise<void> {
    const inflight = this.image.inflight;
    if (!inflight) return;
    const answered = new Set(this.image.history.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id));
    const patched: ConversationMessage[] = [];
    const dangling: string[] = [];
    for (const message of this.image.history) {
      patched.push(message);
      if (message.role !== "assistant" || !message.tool_calls) continue;
      for (const call of message.tool_calls) {
        if (answered.has(call.id)) continue;
        patched.push({ role: "tool", tool_call_id: call.id, name: call.name, content: INTERRUPTED_TOOL, is_error: true });
        dangling.push(call.id);
      }
    }
    const last = patched.at(-1);
    if (last && (last.role !== "assistant" || last.tool_calls)) patched.push({ role: "assistant", content: INTERRUPTED_REPLY });
    this.image.history = patched;
    const turn = this.image.turns.find((t) => t.turnId === inflight.turnId);
    if (turn) turn.interrupted = true;
    // The recording's next step belongs to the turn that was cut; skipping it would replay a conversation that did not happen.
    if (this.image.binding.modelMode === "replay") this.image.replayBroken = true;
    this.image.inflight = null;
    this.project();
    this.emit("run.interrupted", "host", { detail: `turn ${inflight.turnId} did not finish (started ${inflight.startedAt})`, danglingToolCalls: dangling }, { turnId: inflight.turnId });
    await this.reconcileOpen();
    await this.checkpoint();
  }

  private async reconcileOpen(): Promise<void> {
    const engine = this.setup.engine;
    const reconciled: Array<{ executionId: string; from: ExecutionState; to: ExecutionState }> = [];
    for (const stuck of engine.list({ state: "executing" })) {
      let e = await engine.resumePending(stuck.id);
      if (this.setup.settlement === "await-payer") e = await this.continueExecution(e);
      else if (e.state !== "executing") await followUp(e, this.setup, (line) => this.ports.log?.(line));
      reconciled.push({ executionId: stuck.id, from: "executing", to: e.state });
    }
    const expired = engine.expireStale().map((e) => e.id);
    const open = engine.list({ state: ["awaiting_approval", "approved", "executing"] }).map((e) => e.id);
    this.project();
    this.emit("run.resumed", "host", { reconciled, expired, open });
  }

  // ---- commands ------------------------------------------------------------

  async turn(command: { commandId: string; text?: string; exampleTurn?: number }): Promise<{ turnId: string; cursor: number }> {
    const replayed = this.replayed(command.commandId, "turn", { text: command.text ?? null, exampleTurn: command.exampleTurn ?? null });
    if (replayed) return replayed.result as { turnId: string; cursor: number };
    const actor = await this.actor();
    this.refuseIfStopped();
    const text = this.turnText(command);
    this.setup.engine.expireStale();

    const turnId = `turn_${this.image.turns.length + 1}`;
    const origin = command.text === undefined ? "example" : "typed";
    this.image.turns.push({ turnId, index: this.image.turns.length, text: this.redact(text) ?? "", origin, reply: null, tools: [], interrupted: false });
    this.image.inflight = { turnId, commandId: command.commandId, startedAt: this.now().toISOString() };
    this.record(command.commandId, "turn", { text: command.text ?? null, exampleTurn: command.exampleTurn ?? null }, { turnId, cursor: 0 });
    this.approver = { id: actor.userId, channel: "playground" };
    this.currentTurn = turnId;
    this.project();
    this.emit("turn.accepted", "host", { turnId, index: this.image.turns.length - 1, text: this.redact(text) ?? "", origin }, { turnId });
    // Durable before the model is asked anything: a crash from here on is recovered as an interrupted turn, never re-run.
    await this.checkpoint();

    let reply: string;
    let truncated = false;
    try {
      const result = await this.loopOf().turn(text);
      reply = result.reply;
      truncated = result.tool_calls.length > 0 && /too many tool steps/.test(result.reply);
      this.project();
      for (const line of result.not_run) {
        const entry = { ref: line.ref, why: line.why, detail: line.detail ?? null };
        this.image.notRun.push(entry);
        this.emit("line.not_run", "loop", entry, { turnId });
      }
    } catch (err) {
      // A save that failed is not a failed turn: the durable record still says the turn is in flight, and a reopen recovers it.
      if (this.dead) throw this.dead;
      this.project();
      if (err instanceof ReplayExhaustedError) this.image.replayBroken = true;
      this.image.inflight = null;
      this.currentTurn = undefined;
      this.image.commands[command.commandId]!.result = { turnId, cursor: this.image.seq };
      await this.checkpoint();
      throw new HostedRefusal(err instanceof ReplayExhaustedError ? "replay_exhausted" : "turn_failed", err instanceof Error ? err.message : String(err));
    }
    const masked = this.redact(reply) ?? "";
    const record = this.turnRecord();
    if (record) record.reply = masked;
    this.emit("assistant.replied", "loop", { turnId, text: masked, truncated }, { turnId });
    this.image.inflight = null;
    this.currentTurn = undefined;
    const result = { turnId, cursor: this.image.seq };
    this.image.commands[command.commandId]!.result = result;
    await this.checkpoint();
    return result;
  }

  async decide(command: { commandId: string; executionId: string; decision: "approve" | "deny"; binding: ApprovalBinding }): Promise<RunSnapshot> {
    const payload = { executionId: command.executionId, decision: command.decision, binding: command.binding };
    if (this.replayed(command.commandId, "decide", payload)) return this.snapshot();
    const actor = await this.actor();
    this.refuseIfStopped();
    if (this.image.binding.executor === "codespar-test") throw new HostedRefusal("decide_on_proposal", "on codespar-test a person pays the platform proposal, or Aprovações decides it; the run decides nothing");
    const engine = this.setup.engine;
    engine.expireStale();
    const execution = engine.get(command.executionId);
    if (!execution || execution.state !== "awaiting_approval") throw new HostedRefusal("not_awaiting_approval", `${command.executionId} is ${execution?.state ?? "unknown"}`);
    const binding = bindingOf(execution);
    if (canonicalJson(binding) !== canonicalJson(command.binding)) throw new HostedRefusal("decision_stale", `${command.executionId} is not what was shown: the decision names another list, total or mandate`);
    const allowed = await this.ports.approval.authorize({ runId: this.image.runId, executionId: execution.id, decision: command.decision, binding, actor });
    if (!allowed.ok) throw new HostedRefusal("not_authorized", `${allowed.code}: ${allowed.message}`);

    this.record(command.commandId, "decide", payload, null);
    this.approver = { id: actor.userId, channel: "playground" };
    const decided = command.decision === "approve" ? engine.approve(execution.id, this.approver) : engine.deny(execution.id, this.approver);
    this.decided(decided, command.decision);
    await this.continueExecution(decided);
    await this.checkpoint();
    return this.snapshot();
  }

  /** One gesture on a presented list: every line approved but the vetoed positions, each line still through the engine's own approval. */
  async decideBatch(command: { commandId: string; batchRef: string; batchHash: string; count: number; vetoed: number[] }): Promise<RunSnapshot> {
    const payload = { batchRef: command.batchRef, batchHash: command.batchHash, count: command.count, vetoed: [...command.vetoed].sort((a, b) => a - b) };
    if (this.replayed(command.commandId, "decide_batch", payload)) return this.snapshot();
    const actor = await this.actor();
    this.refuseIfStopped();
    if (this.image.binding.executor === "codespar-test") throw new HostedRefusal("decide_on_proposal", "on codespar-test a person pays the platform proposal, or Aprovações decides it; the run decides nothing");
    const engine = this.setup.engine;
    engine.expireStale();
    const presented = this.image.batches[command.batchRef];
    if (!presented) throw new HostedRefusal("not_awaiting_approval", `no list ${command.batchRef} was presented in this run`);
    if (presented.presentation.batch_hash !== command.batchHash || presented.presentation.count !== command.count) throw new HostedRefusal("decision_stale", `list ${command.batchRef} is not the one that was shown`);
    if (payload.vetoed.some((i) => !Number.isInteger(i) || i < 0 || i >= command.count) || new Set(payload.vetoed).size !== payload.vetoed.length) throw new HostedRefusal("invalid_command", "vetoed names positions of the list, 0-based, each once");
    const lines = engine
      .list({ state: "awaiting_approval" })
      .filter((e) => e.batch?.ref === command.batchRef)
      .sort((a, b) => a.batch!.index - b.batch!.index);
    if (lines.length === 0) throw new HostedRefusal("not_awaiting_approval", `no line of ${command.batchRef} is awaiting approval`);
    const vetoed = new Set(payload.vetoed);
    for (const line of lines) {
      const allowed = await this.ports.approval.authorize({ runId: this.image.runId, executionId: line.id, decision: vetoed.has(line.batch!.index) ? "deny" : "approve", binding: bindingOf(line), actor });
      if (!allowed.ok) throw new HostedRefusal("not_authorized", `${line.id}: ${allowed.code}: ${allowed.message}`);
    }

    this.record(command.commandId, "decide_batch", payload, null);
    this.approver = { id: actor.userId, channel: "playground" };
    const approved = presented.presentation.lines.map((l) => l.index).filter((i) => !vetoed.has(i));
    presented.gesture = { batchHash: command.batchHash, vetoed: payload.vetoed };
    this.project();
    this.emit("batch.decided", "host", { batchHash: command.batchHash, count: command.count, approved, vetoed: payload.vetoed, actor: { type: "human", id: actor.userId, channel: "playground" } }, { batchRef: command.batchRef });
    engine.note("batch.gesture", null, { batch_ref: command.batchRef, batch_hash: command.batchHash, count: command.count, total_minor: presented.presentation.total_minor, approved, vetoed: payload.vetoed, approver: { type: "human", id: actor.userId, channel: "playground" } });
    const gesture: BatchGestureRecord = { batch_hash: command.batchHash, count: command.count, vetoed };
    for (const line of lines) {
      const decided = decideByGesture(line, gesture, this.setup, this.approver);
      this.decided(decided, vetoed.has(line.batch!.index) ? "deny" : "approve");
      await this.continueExecution(decided);
    }
    await this.checkpoint();
    return this.snapshot();
  }

  /** Test only: the counterparty pays (or lets the receivable expire), through the kit's own sandbox payer, and the run looks once. */
  async simulatePayer(command: { commandId: string; executionId: string; behaviour: "pays" | "expires" }): Promise<RunSnapshot> {
    const payload = { executionId: command.executionId, behaviour: command.behaviour };
    if (this.replayed(command.commandId, "simulate_payer", payload)) return this.snapshot();
    await this.actor();
    this.refuseIfStopped();
    const payer = this.setup.payer;
    if (!payer || (command.behaviour === "expires" && !payer.decideFor)) throw new HostedRefusal("payer_not_simulatable", `this executor cannot make the payer ${command.behaviour === "pays" ? "pay" : "let it expire"}`);
    const execution = this.setup.engine.get(command.executionId);
    const issued = execution?.outcomes.filter((o) => o.status === "accepted" && o.transaction_id) ?? [];
    if (!execution || execution.state !== "executing" || issued.length === 0) throw new HostedRefusal("not_awaiting_payer", `${command.executionId} has no receivable waiting for its payer`);

    this.record(command.commandId, "simulate_payer", payload, null);
    for (const outcome of issued) {
      if (command.behaviour === "expires") {
        payer.decideFor!(outcome.attempt_id, "expires");
        this.setup.engine.note("sandbox_payer", execution.id, { charge_id: outcome.transaction_id, ok: true, detail: "simulated: the payer lets it expire" });
        continue;
      }
      const result = await payer.pay(outcome.transaction_id!, outcome.attempt_id);
      this.setup.engine.note("sandbox_payer", execution.id, { charge_id: outcome.transaction_id, ok: result.ok, detail: result.detail });
    }
    await this.continueExecution(this.setup.engine.get(execution.id)!);
    await this.checkpoint();
    return this.snapshot();
  }

  /** Looks at every open execution again (never re-sending past an outbox row marked `sent`), and expires stale approvals. */
  async resume(command: { commandId: string }): Promise<RunSnapshot> {
    if (this.replayed(command.commandId, "resume", {})) return this.snapshot();
    await this.actor();
    this.record(command.commandId, "resume", {}, null);
    await this.reconcileOpen();
    await this.checkpoint();
    return this.snapshot();
  }

  /** No further turn or decision. What is awaiting a decision is denied; what was sent stays with reconciliation; nothing is erased. */
  async stop(command: { commandId: string; reason?: string }): Promise<RunSnapshot> {
    if (this.replayed(command.commandId, "stop", { reason: command.reason ?? null })) return this.snapshot();
    const actor = await this.actor();
    if (this.image.stopped) return this.snapshot();
    this.record(command.commandId, "stop", { reason: command.reason ?? null }, null);
    const engine = this.setup.engine;
    const by = { id: actor.userId, channel: "playground" };
    const deniedOpen = engine.list({ state: "awaiting_approval" }).map((e) => engine.deny(e.id, by, "the run was stopped").id);
    const stillExecuting = engine.list({ state: "executing" }).map((e) => e.id);
    this.project();
    this.image.stopped = { at: this.now().toISOString(), by: actor.userId, reason: command.reason ?? null };
    this.emit("run.stopped", "host", { actor: { type: "human", id: actor.userId, channel: "playground" }, reason: command.reason ?? null, deniedOpen, stillExecuting });
    await this.checkpoint();
    return this.snapshot();
  }

  async events(after: number): Promise<{ events: HostedEvent[]; cursor: number }> {
    await this.actor();
    return { events: await this.ports.state.events(this.image.runId, after), cursor: this.image.seq };
  }

  // ---- reads -----------------------------------------------------------------

  async snapshot(): Promise<RunSnapshot> {
    await this.actor();
    return snapshotOf(this.image, this.setup.store, this.kit.descriptor, Boolean(this.setup.payer));
  }

  /** What a person may download: the masked bundle, no key, no signature value, no payee key in the clear. */
  async export(): Promise<RunExport> {
    const snapshot = await this.snapshot();
    const lines = (path: string) =>
      (this.files.read(path) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((l) => this.maskDeep(JSON.parse(l)));
    const bundle = this.setup.bundle;
    const approvals = bundle.readApprovals().map(({ signature: _signature, ...rest }) => this.maskDeep(rest));
    const receipts = bundle.listReceipts().map((f) => this.maskDeep(bundle.readReceipt(f)));
    const d = this.kit.descriptor;
    const b = this.image.binding;
    const commands = [
      `npx degit codespar/agent-starter-kits/agents/${d.id}#${d.source.commit} ${d.id}`,
      `cd ${d.id} && npm install`,
      b.modelMode === "replay" && b.exampleId ? `npm start -- --scenario ${b.exampleId} --mode ${b.approvalMode} --locale ${b.locale}` : `npm start -- --mode ${b.approvalMode} --locale ${b.locale}`,
    ];
    return {
      v: 1,
      descriptor: d,
      run: snapshot.run,
      events: lines("events.jsonl"),
      transcript: lines("transcript.jsonl"),
      approvals,
      receipts,
      mandateSnapshot: this.maskDeep(bundle.readMandateSnapshot() ?? null),
      code: { repository: d.source.repository, commit: d.source.commit, kitPath: `agents/${d.id}`, commands },
    };
  }

  // ---- internals ---------------------------------------------------------

  /** Persists the run and the events produced since the last save, in one compare-and-set. Nothing is published before this returns. */
  async checkpoint(): Promise<void> {
    if (this.dead) throw this.dead;
    this.project();
    const image = this.image;
    image.store = this.setup.store.exportImage();
    image.bundle = Object.fromEntries(this.files.files);
    if (this.loop) {
      image.history = [...this.loop.history];
      image.language = this.loop.replyLanguage ?? null;
    }
    if (this.replay) image.replayCursor = this.replay.consumed;
    image.status = statusOf(image, this.setup.store);
    image.updatedAt = this.now().toISOString();
    let saved: Awaited<ReturnType<StatePort["save"]>>;
    try {
      saved = await this.ports.state.save(image.runId, image, this.unsaved, this.revision);
    } catch (err) {
      this.dead = err instanceof Error ? err : new Error(String(err));
      throw this.dead;
    }
    if (!saved.ok) {
      this.dead =
        saved.reason === "binding_changed"
          ? new HostedRefusal("binding_changed", `the host holds another binding for an execution of run ${image.runId}; nothing of this save was kept`)
          : new HostedRefusal("revision_conflict", `run ${image.runId} changed under this process; reopen it`);
      throw this.dead;
    }
    this.revision = saved.revision;
    this.unsaved = [];
  }

  /** Engine rows since the last projection, as contract events. The engine's log is the source; these are its view. */
  private project(): void {
    const rows = this.setup.store.listEvents({ after_seq: this.image.projected.storeSeq });
    for (const row of rows) {
      this.image.projected.storeSeq = row.seq;
      this.translate(row);
    }
  }

  private translate(row: EventRow): void {
    const store = this.setup.store;
    const execution = row.execution_id ? store.getExecution(row.execution_id) : undefined;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const ref = { ...(row.execution_id ? { executionId: row.execution_id } : {}), ...(execution?.batch ? { batchRef: execution.batch.ref } : {}) };
    const evidence = this.evidenceKind();
    switch (row.type) {
      case "execution.drafted":
        if (execution) this.emit("execution.proposed", "engine", viewOf(execution, store, evidence, { asDrafted: true, redact: this.redact }), { ...ref, ...this.turnRef(), ...(this.currentTool ? { toolCallId: this.currentTool } : {}) }, row.at);
        return;
      case "execution.transition": {
        const t = payload as unknown as TransitionRecord;
        this.emit("execution.transitioned", "engine", { from: t.from, to: t.to, reason: t.reason ?? null, detail: this.redact(t.detail ?? null), actor: actorView(t.actor) }, ref, row.at);
        if (!execution) return;
        if (t.to === "awaiting_approval") {
          this.emit("approval.requested", "engine", { binding: bindingOf(execution), rule: ruleOf(execution, this.redact), canApprove: execution.blocking_reasons.length === 0, blockingReasons: [...execution.blocking_reasons], expiresAt: null }, ref, row.at);
        }
        if (isTerminal(t.to)) {
          this.emit("outcome.confirmed", "engine", { state: t.to as "settled" | "failed" | "denied" | "expired", reason: t.reason ?? null, evidence: evidenceOf(execution, evidence) }, ref, row.at);
        }
        return;
      }
      case "rail.dispatch":
        this.emit(
          "dispatch.attempted",
          "engine",
          { attemptId: String(payload["attempt_id"]), idempotencyKey: String(payload["idempotency_key"] ?? ""), amountMinor: Number(payload["amount"]), payeeMasked: maskPayee(String(payload["payee"] ?? "")), rail: String(payload["rail"] ?? "") },
          { ...ref, attemptId: String(payload["attempt_id"]) },
          row.at,
        );
        return;
      case "charge.instrument": {
        const outcome = execution?.outcomes.find((o) => o.attempt_id === payload["attempt_id"]);
        if (this.image.binding.executor === "codespar-test") {
          const proposalId = String(payload["charge_id"]);
          this.emit("proposal.updated", "engine", { proposalId, attemptId: String(payload["attempt_id"]), state: String(payload["status"]) as "drafted" }, { ...ref, proposalId, attemptId: String(payload["attempt_id"]) }, row.at);
          return;
        }
        const instrument = outcome?.instrument;
        this.emit(
          "instrument.presented",
          "engine",
          {
            chargeId: String(payload["charge_id"]),
            instalment: (outcome?.index ?? 0) + 1,
            payable: Boolean(payload["payable"]),
            status: String(payload["status"]),
            dueDate: (payload["due_date"] as string | null) ?? null,
            pixCopyPaste: instrument?.pix_copy_paste ?? null,
            boletoLine: instrument?.boleto_bank_line ?? null,
            consentUrl: instrument?.consent_url ?? null,
          },
          { ...ref, chargeId: String(payload["charge_id"]), attemptId: String(payload["attempt_id"]) },
          row.at,
        );
        return;
      }
      case "execution.uncertain":
        this.emit("outcome.pending", "engine", { kind: payload["needs_human"] ? "needs_human" : "uncertain", detail: this.redact(String(payload["detail"] ?? "")) ?? "" }, ref, row.at);
        return;
      case "execution.awaiting_settlement":
        this.emit("outcome.pending", "engine", { kind: this.image.binding.executor === "codespar-test" ? "awaiting_proposal" : "awaiting_payer", detail: this.redact(String(payload["detail"] ?? "")) ?? "" }, ref, row.at);
        return;
      default:
        return;
    }
  }

  private decided(execution: Execution, decision: "approve" | "deny" | "forward", channel: "playground" | "platform-proposal" = "playground"): void {
    this.project();
    this.emit(
      "approval.decided",
      "host",
      { decision, actor: { type: "human", id: this.approver.id, channel }, approvalId: execution.approval_id ?? null, resultState: execution.state },
      { executionId: execution.id, ...(execution.approval_id ? { approvalId: execution.approval_id } : {}), ...(execution.batch ? { batchRef: execution.batch.ref } : {}) },
    );
  }

  private evidenceKind(): EvidenceKind {
    const executor = this.kit.descriptor.executors.find((e) => e.id === this.image.binding.executor);
    return executor?.evidence ?? "none";
  }

  private emit<T extends HostedEventType>(type: T, source: HostedEvent["source"], data: HostedEvent<T>["data"], ref: HostedEvent["ref"] = {}, at?: string): void {
    this.image.seq += 1;
    const event = { v: 1 as const, runId: this.image.runId, seq: this.image.seq, at: at ?? this.now().toISOString(), type, source, ...(ref && Object.keys(ref).length > 0 ? { ref } : {}), data } as HostedEvent;
    this.unsaved.push(event);
  }

  private turnRef(): { turnId?: string } {
    return this.currentTurn ? { turnId: this.currentTurn } : {};
  }

  private turnRecord(): TurnRecord | undefined {
    return this.currentTurn ? this.image.turns.find((t) => t.turnId === this.currentTurn) : undefined;
  }

  /** The actor of this command, refused when it is not of the run's organization and project. */
  private async actor(): Promise<HostedActor> {
    if (this.dead) throw this.dead;
    const actor = await this.ports.identity.actor();
    const owner = this.image.owner;
    if (actor.orgId !== owner.orgId || actor.projectId !== owner.projectId) throw new HostedRefusal("not_authorized", "the run belongs to another project");
    return actor;
  }

  private refuseIfStopped(): void {
    if (this.image.stopped) throw new HostedRefusal("run_stopped", `stopped at ${this.image.stopped.at}`);
  }

  private turnText(command: { text?: string; exampleTurn?: number }): string {
    const example = this.example();
    let text: string;
    if (this.image.binding.modelMode === "replay") {
      if (command.text !== undefined) throw new HostedRefusal("replay_requires_example_turn", "a replay runs the example's recorded turns, in order");
      if (this.image.replayBroken) throw new HostedRefusal("replay_exhausted", "the recording cannot continue past an interrupted or exhausted turn; start a new run");
      const done = this.image.turns.filter((t) => t.origin === "example").length;
      if (command.exampleTurn !== done) throw new HostedRefusal("replay_requires_example_turn", `the next recorded turn is ${done}`);
      const next = example?.turns[done];
      if (!next) throw new HostedRefusal("replay_exhausted", "every recorded turn of the example has run");
      text = next.input;
    } else if (command.text !== undefined) {
      text = command.text;
    } else {
      const next = command.exampleTurn !== undefined ? example?.turns[command.exampleTurn] : undefined;
      if (!next) throw new HostedRefusal("invalid_command", "a turn carries text, or names a turn of the run's example");
      text = next.input;
    }
    if (text.trim().length === 0 || text.length > 4000) throw new HostedRefusal("invalid_command", "a turn's text is 1 to 4000 characters");
    return text;
  }

  /** A command already applied: the same id with the same payload is answered from the record; with another payload it is refused. */
  private replayed(commandId: string, type: string, payload: unknown): { result: unknown } | undefined {
    if (!commandId) throw new HostedRefusal("invalid_command", "every command carries a commandId");
    const prior = this.image.commands[commandId];
    if (!prior) return undefined;
    if (prior.type !== type || prior.payloadHash !== sha256(payload)) throw new HostedRefusal("command_conflict", `command ${commandId} was already used for another ${prior.type}`);
    return { result: prior.result };
  }

  private record(commandId: string, type: string, payload: unknown, result: unknown): void {
    this.image.commands[commandId] = { type, payloadHash: sha256(payload), result };
  }

  /** Payee keys masked wherever they appear: a key in a field named `payee`, and any key the mandate names or that looks like one, in any string. */
  private maskDeep(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "payee" && typeof v === "string" && !v.includes("***") ? maskPayee(v) : this.maskDeep(v)]));
    return value;
  }
}

// ---- views -------------------------------------------------------------------

function actorView(actor: Actor): ActorView {
  return actor.type === "agent" ? { type: "agent", agent: actor.agent, onBehalfOf: actor.on_behalf_of } : { type: "human", id: actor.id, channel: actor.channel === "platform-proposal" ? "platform-proposal" : "playground" };
}

export function bindingOf(e: Execution): ApprovalBinding {
  return {
    itemsHash: e.items_hash,
    totalMinor: e.total,
    currency: "BRL",
    mandateId: e.mandate.id,
    mandateVersion: e.mandate.version,
    batchHash: e.batch?.batch_hash ?? null,
    batchIndex: e.batch?.index ?? null,
    compositionHash: e.composition?.composition_hash ?? null,
  };
}

function ruleOf(e: Execution, redact: (v: string | null) => string | null): { approvalMode: "human" | "mandate"; trigger: string | null; detail: string | null } {
  return { approvalMode: e.mode, trigger: e.escalation?.trigger ?? null, detail: redact(e.escalation?.detail ?? e.detail ?? null) };
}

function evidenceOf(e: Execution, kind: EvidenceKind): EvidenceRef[] {
  if (kind === "none") return [];
  return e.outcomes.map((o) => {
    if (o.status === "settled") return { kind, id: o.receipt_id ?? o.transaction_id ?? o.attempt_id, detail: kind === "simulated" ? "simulator: not a CodeSpar receipt" : null };
    if (o.status === "accepted") return { kind, id: o.transaction_id ?? o.attempt_id, detail: kind === "codespar_receipt" ? `platform proposal ${o.instrument?.status ?? "drafted"}; not paid` : "issued; the payer has not paid" };
    return { kind, id: o.attempt_id, detail: o.error ?? o.code ?? "failed" };
  });
}

function viewOf(e: Execution, store: StateStore, evidence: EvidenceKind, options: { asDrafted?: boolean; redact: (v: string | null) => string | null }): ExecutionView {
  const drafted = options.asDrafted === true;
  const approval = !drafted && e.approval_id ? store.getApproval(e.approval_id) : undefined;
  const approvedBy: ActorView | null = approval ? (approval.approver.type === "mandate" ? { type: "mandate", id: approval.approver.id } : actorView({ type: "human", id: approval.approver.id, channel: approval.approver.channel })) : null;
  const items = e.items.map((i) => ({ beneficiary: i.beneficiary, payeeMasked: maskPayee(i.payee), alias: i.alias ?? null, amountMinor: i.amount, description: options.redact(i.description ?? null), dueDate: i.due_date ?? null }));
  return {
    id: e.id,
    state: drafted ? "drafted" : e.state,
    reason: drafted ? null : (e.reason ?? null),
    detail: drafted ? null : options.redact(e.detail ?? null),
    approvalMode: e.mode,
    items: items as ExecutionView["items"],
    totalMinor: e.total,
    currency: "BRL",
    itemsHash: e.items_hash,
    batch: e.batch ? { ref: e.batch.ref, batchHash: e.batch.batch_hash, index: e.batch.index, count: e.batch.count } : null,
    compositionHash: e.composition?.composition_hash ?? null,
    escalation: drafted || !e.escalation ? null : { trigger: e.escalation.trigger, detail: options.redact(e.escalation.detail) ?? "" },
    approvalId: drafted ? null : (e.approval_id ?? null),
    approvedBy,
    attempts: drafted
      ? []
      : [
          ...e.outcomes.map((o) => ({ attemptId: o.attempt_id, status: o.status, code: o.code ?? null, message: options.redact(o.message ?? null) })),
          ...(e.uncertain_answers ?? []).filter((a) => !e.outcomes.some((o) => o.attempt_id === a.attempt_id)).map((a) => ({ attemptId: a.attempt_id, status: "uncertain" as const, code: a.code, message: options.redact(a.message) })),
        ],
    evidence: drafted ? [] : evidenceOf(e, evidence),
    history: drafted ? [] : e.history.map((h) => ({ from: h.from, to: h.to, at: h.at, reason: h.reason ?? null, actor: actorView(h.actor) })),
    createdAt: e.created_at,
    updatedAt: drafted ? e.created_at : e.updated_at,
  };
}

function presentationView(batch: BatchPresentation): BatchView {
  return {
    batchRef: batch.ref,
    label: batch.label,
    batchHash: batch.batch_hash,
    count: batch.count,
    totalMinor: batch.total_minor,
    settledMinor: 0,
    lines: batch.lines.map((l) => ({ index: l.index, beneficiary: l.beneficiary, amountMinor: l.amount_minor, executionId: null, state: l.status, reason: null, evidence: [] })),
  };
}

function statusOf(image: RunImage, store: StateStore): RunStatus {
  if (image.stopped) return "stopped";
  if (image.inflight) return "running";
  const open = store.listExecutions({ state: ["awaiting_approval", "executing"] });
  if (open.some((e) => e.state === "awaiting_approval")) return "awaiting_decision";
  if (open.some((e) => e.state === "executing" && !isAwaitingPayer(e))) return "awaiting_reconciliation";
  // A proposal waits for a person to pay it: a decision, taken on the platform.
  if (image.binding.executor === "codespar-test" && open.some((e) => e.state === "executing")) return "awaiting_decision";
  if (open.some((e) => e.state === "executing")) return "awaiting_payer";
  return "idle";
}

/** The run as a reader sees it: built from the store and the image, never from the event stream. */
export function snapshotOf(image: RunImage, store: StateStore, descriptor: HostedKitDescriptor, payerSimulatable: boolean): RunSnapshot {
  const evidence = descriptor.executors.find((e) => e.id === image.binding.executor)?.evidence ?? "none";
  const mandatePayees = new Set<string>();
  for (const e of store.listExecutions()) for (const i of e.items) mandatePayees.add(i.payee);
  const redact = redactorFor(mandatePayees);
  const executions = store.listExecutions();
  const status = statusOf(image, store);
  const pending: PendingAction[] = [];
  if (status !== "running" && status !== "stopped") {
    for (const e of executions.filter((x) => x.state === "awaiting_approval" && !x.batch)) {
      const view = viewOf(e, store, evidence, { redact });
      pending.push({ kind: "decision", executionId: e.id, binding: bindingOf(e), items: view.items, rule: ruleOf(e, redact), canApprove: e.blocking_reasons.length === 0, blockingReasons: [...e.blocking_reasons], expiresAt: null });
    }
    const batchRefs = [...new Set(executions.filter((x) => x.state === "awaiting_approval" && x.batch).map((x) => x.batch!.ref))];
    for (const ref of batchRefs) {
      const presented = image.batches[ref]?.presentation;
      const lines = executions.filter((x) => x.batch?.ref === ref);
      const first = lines[0]!.batch!;
      pending.push({
        kind: "batch_decision",
        batchRef: ref,
        batchHash: presented?.batch_hash ?? first.batch_hash,
        count: presented?.count ?? first.count,
        totalMinor: presented?.total_minor ?? lines.reduce((sum, x) => sum + x.total, 0),
        lines: (presented?.lines ?? []).map((l) => {
          const line = lines.find((x) => x.batch!.index === l.index && x.batch!.batch_hash === presented!.batch_hash);
          return { index: l.index, executionId: line?.id ?? null, beneficiary: l.beneficiary, amountMinor: l.amount_minor, status: line?.state ?? l.status };
        }),
      });
    }
    for (const e of executions.filter((x) => x.state === "executing")) {
      if (!isAwaitingPayer(e)) {
        pending.push({ kind: "reconciliation", executionId: e.id, detail: redact(e.detail ?? "") ?? "" });
        continue;
      }
      for (const o of e.outcomes) {
        if (o.status !== "accepted" || !o.transaction_id || !o.instrument) continue;
        if (image.binding.executor === "codespar-test") {
          const state = o.instrument.status;
          pending.push({ kind: "payment_proposal", executionId: e.id, proposalId: o.transaction_id, proposalState: state === "awaiting_approval" || state === "executing" ? state : "drafted" });
          continue;
        }
        const i = o.instrument;
        pending.push({
          kind: "payer",
          executionId: e.id,
          chargeId: o.transaction_id,
          instalment: o.index + 1,
          instrument: { payable: i.payable, status: i.status, dueDate: i.due_date, pixCopyPaste: i.pix_copy_paste, boletoLine: i.boleto_bank_line, consentUrl: i.consent_url ?? null },
          simulatable: payerSimulatable,
        });
      }
    }
  }
  const batches: BatchView[] = Object.values(image.batches).map(({ presentation }) => {
    const lines = presentation.lines.map((l) => {
      const e = executions.find((x) => x.batch?.ref === presentation.ref && x.batch.index === l.index && x.batch.batch_hash === presentation.batch_hash);
      return { index: l.index, beneficiary: l.beneficiary, amountMinor: l.amount_minor, executionId: e?.id ?? null, state: e?.state ?? l.status, reason: e?.reason ?? null, evidence: e ? evidenceOf(e, evidence) : [] };
    });
    const settledMinor = lines.filter((l) => l.state === "settled").reduce((sum, l) => sum + l.amountMinor, 0);
    return { batchRef: presentation.ref, label: presentation.label, batchHash: presentation.batch_hash, count: presentation.count, totalMinor: presentation.total_minor, settledMinor, lines };
  });
  const example = image.binding.exampleId === null ? undefined : descriptor.examples.find((e) => e.id === image.binding.exampleId);
  const done = image.turns.filter((t) => t.origin === "example").length;
  return {
    v: 1,
    run: {
      id: image.runId,
      kit: image.kit,
      modelMode: image.binding.modelMode,
      executor: image.binding.executor,
      approvalMode: image.binding.approvalMode,
      locale: image.binding.locale,
      exampleId: image.binding.exampleId,
      inputRevision: image.binding.inputRevision,
      status,
      createdAt: image.createdAt,
      updatedAt: image.updatedAt,
    },
    cursor: { seq: image.seq },
    pending,
    executions: executions.map((e) => viewOf(e, store, evidence, { redact })),
    batches,
    turns: image.turns.map(({ origin: _origin, ...t }) => t),
    notRun: image.notRun,
    replay: example
      ? {
          exampleId: example.id,
          turnsTotal: example.turns.length,
          turnsDone: done,
          nextTurnText: image.binding.modelMode === "replay" && !image.replayBroken && done < example.turns.length ? example.turns[done]!.input : null,
        }
      : null,
  };
}
