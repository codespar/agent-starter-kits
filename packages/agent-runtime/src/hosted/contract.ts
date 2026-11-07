/**
 * The hosted contract, version 1: what a host (the CodeSpar Playground) reads
 * about a kit before it runs one, and what it reads back while the run goes.
 * The prose is `playground-executavel/CONTRATO.md`; this file is the part a
 * machine checks, and the catalog generator, the conformance suite and the
 * fixtures the dashboard builds against are all validated by it.
 *
 * Nothing here decides anything about money. The engine does that, at its
 * three gates, exactly as on a terminal; these are the shapes in which its
 * decisions travel to a host, with the kit's own states and reasons kept as
 * they are.
 */
import { z } from "zod";

export const CONTRACT_VERSION = 1;

export const ModelModeSchema = z.enum(["replay", "model"]);
export const ExecutorIdSchema = z.enum(["simulator", "codespar-test"]);
export const OutcomeKindSchema = z.enum(["answer", "payment", "charge", "order", "pull"]);
/**
 * What stands behind an outcome. `simulated` is the kit's stub rail and is
 * never shown as a receipt; `codespar_receipt` is a payment the API sealed;
 * `charge_status` is a charge the API reports paid, for which it seals no
 * record; `rail_record` is a rail that is not CodeSpar's.
 */
export const EvidenceKindSchema = z.enum(["none", "simulated", "codespar_receipt", "charge_status", "rail_record"]);
/** The closed list of platform prerequisites a descriptor may name; the host maps each one to readiness. */
export const PlatformPrerequisiteSchema = z.enum(["platform.test_project", "platform.consumer_mandate", "platform.payouts", "platform.charges"]);
/** What the platform does not offer yet and an executor would need: listed in `blockedBy`, never worked around. */
export const PLATFORM_GAPS: readonly string[] = ["platform.charge_proposals"];
export const ApprovalModeSchema = z.enum(["human", "mandate"]);
export const LocaleNameSchema = z.enum(["pt-BR", "en"]);
export const ToolEffectSchema = z.enum(["payment", "charge", "read", "state"]);
export const ExecutionStateSchema = z.enum(["drafted", "awaiting_approval", "approved", "executing", "settled", "failed", "denied", "expired"]);

export type ModelMode = z.infer<typeof ModelModeSchema>;
export type ExecutorId = z.infer<typeof ExecutorIdSchema>;
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type PlatformPrerequisite = z.infer<typeof PlatformPrerequisiteSchema>;

const COMMIT = /^[0-9a-f]{40}$/;
/** A run id the host assigns (`pkr_…` in the API) or the runtime generates (`run_…`). */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

const JsonSchemaObject = z.record(z.string(), z.unknown());

export const HostedKitDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    contractVersion: z.literal(CONTRACT_VERSION),
    source: z
      .object({
        repository: z.literal("codespar/agent-starter-kits"),
        commit: z.string().regex(COMMIT, "a full 40-hex commit"),
        packageDigest: z.string().regex(DIGEST, 'expected "sha256:<64 hex>"'),
      })
      .strict(),
    /** A path inside the artifact. Never taken from a request. */
    entrypoint: z.string().regex(/^kits\/[a-z0-9-]+\/src\/kit\.js$/),
    inputSchema: JsonSchemaObject,
    turnSchema: JsonSchemaObject,
    requiredCapabilities: z.array(z.string()),
    capabilityMaturity: z.record(z.string(), z.enum(["live", "sandbox", "blocked"])),
    supportedModelModes: z.array(ModelModeSchema).nonempty(),
    supportedExecutors: z.array(ExecutorIdSchema).nonempty(),
    executors: z
      .array(
        z
          .object({
            id: ExecutorIdSchema,
            evidence: EvidenceKindSchema,
            requires: z.array(PlatformPrerequisiteSchema),
            blockedBy: z.array(z.string()),
          })
          .strict(),
      )
      .nonempty(),
    outcomeKinds: z.array(OutcomeKindSchema).nonempty(),
    settlement: z.enum(["none", "immediate", "await-payer"]),
    needsMandate: z.boolean(),
    approvalModes: z.array(ApprovalModeSchema).nonempty(),
    defaultApprovalMode: ApprovalModeSchema,
    tools: z.array(z.object({ name: z.string(), effect: ToolEffectSchema }).strict()),
    locales: z.array(LocaleNameSchema).nonempty(),
    defaultLocale: LocaleNameSchema,
    /** The kit's own words per locale (`agent.yaml` `presentation`), or null when it declares none. */
    presentation: z.object({ "pt-BR": z.object({ title: z.string(), summary: z.string() }).strict(), en: z.object({ title: z.string(), summary: z.string() }).strict() }).strict().nullable(),
    /** The first experiment the kit recommends (`presentation.recommended`): an example it replays on the simulator. `rank` 1 is offered first. */
    recommended: z.object({ example: z.string(), rank: z.number().int().min(1) }).strict().nullable(),
    /** First runs on another executor and model mode than the simulator's replay (`presentation.recommendedRuns`): today the integrated Test with a model. */
    recommendedRuns: z.array(z.object({ executor: z.literal("codespar-test"), modelMode: z.literal("model"), example: z.string(), rank: z.number().int().min(1).max(99) }).strict()),
    exampleIds: z.array(z.string()),
    examples: z.array(
      z
        .object({
          id: z.string(),
          description: z.string(),
          approvalModes: z.array(ApprovalModeSchema).nonempty(),
          /** What the person typed in each recorded turn, in order; `input` as in the scenario pack. */
          turns: z.array(z.object({ input: z.string() }).strict()).nonempty(),
          replay: z.boolean(),
          presentation: z
            .object({ "pt-BR": z.object({ title: z.string(), description: z.string() }).strict(), en: z.object({ title: z.string(), description: z.string() }).strict() })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((d, ctx) => {
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if (d.entrypoint !== `kits/${d.id}/src/kit.js`) issue(`entrypoint must be kits/${d.id}/src/kit.js`, ["entrypoint"]);
    const executorIds = d.executors.map((e) => e.id);
    if (JSON.stringify(executorIds) !== JSON.stringify(d.supportedExecutors)) issue("supportedExecutors must list executors[].id in order", ["supportedExecutors"]);
    if (!d.approvalModes.includes(d.defaultApprovalMode)) issue("defaultApprovalMode must be one of approvalModes", ["defaultApprovalMode"]);
    if (!d.locales.includes(d.defaultLocale)) issue("defaultLocale must be one of locales", ["defaultLocale"]);
    if (JSON.stringify(d.exampleIds) !== JSON.stringify(d.examples.map((e) => e.id))) issue("exampleIds must list examples[].id in order", ["exampleIds"]);
    if (d.supportedModelModes.includes("replay") && !d.examples.some((e) => e.replay)) issue("replay needs an example with a transcript", ["supportedModelModes"]);
    if (d.recommended && !d.examples.some((e) => e.id === d.recommended!.example && e.replay)) issue("the recommended example must be one of the kit's examples, with a recorded transcript", ["recommended"]);
    for (const [i, r] of d.recommendedRuns.entries()) {
      if (!d.examples.some((e) => e.id === r.example && e.turns.length > 0)) issue("a recommended run names one of the kit's examples, with a first input", ["recommendedRuns", i]);
      const executor = d.executors.find((e) => e.id === r.executor);
      if (!executor || executor.blockedBy.length > 0) issue(`a recommended run on ${r.executor} needs that executor, unblocked`, ["recommendedRuns", i]);
      if (!d.supportedModelModes.includes(r.modelMode)) issue(`a recommended run in ${r.modelMode} needs that model mode`, ["recommendedRuns", i]);
    }
    const moves = d.tools.some((t) => t.effect === "payment" || t.effect === "charge");
    if (d.needsMandate !== moves) issue("needsMandate is true exactly when a payment or charge tool exists", ["needsMandate"]);
    if ((d.settlement === "none") !== !moves) issue('settlement is "none" exactly when no payment or charge tool exists', ["settlement"]);
    if (!d.outcomeKinds.includes("answer")) issue("every kit answers", ["outcomeKinds"]);
    if (!moves && d.outcomeKinds.some((k) => k !== "answer")) issue("a read-only kit has no money outcome", ["outcomeKinds"]);
    for (const [i, e] of d.executors.entries()) {
      if (!moves && e.evidence !== "none") issue("a read-only kit has no evidence to show", ["executors", i, "evidence"]);
      if (e.id === "simulator" && (e.requires.length > 0 || (e.evidence !== "simulated" && e.evidence !== "none"))) issue("the simulator needs nothing from the platform and proves nothing but simulation", ["executors", i]);
      if (e.id === "codespar-test" && !e.requires.includes("platform.test_project")) issue("codespar-test runs in a Test project", ["executors", i, "requires"]);
      for (const cap of e.blockedBy) if (d.capabilityMaturity[cap] !== "blocked" && !PLATFORM_GAPS.includes(cap)) issue(`blockedBy names ${cap}, which is neither blocked in the manifest nor a known platform gap`, ["executors", i, "blockedBy"]);
    }
  });

export const HostedCatalogSchema = z
  .object({
    v: z.literal(1),
    contractVersion: z.literal(CONTRACT_VERSION),
    artifact: z.object({ name: z.literal("@codespar/hosted-kits"), version: z.string(), commit: z.string().regex(COMMIT) }).strict(),
    kits: z.array(HostedKitDescriptorSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = c.kits.map((k) => k.id);
    if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "kits sorted by id", path: ["kits"] });
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate kit id", path: ["kits"] });
    const ranks = c.kits.flatMap((k) => (k.recommended ? [k.recommended.rank] : []));
    if (new Set(ranks).size !== ranks.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "two kits recommend a first experiment at the same rank", path: ["kits"] });
    const runRanks = c.kits.flatMap((k) => k.recommendedRuns.map((r) => `${r.executor}:${r.rank}`));
    if (new Set(runRanks).size !== runRanks.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "two kits recommend a run at the same rank on the same executor", path: ["kits"] });
    for (const [i, k] of c.kits.entries()) if (k.source.commit !== c.artifact.commit) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "every kit comes from the artifact's commit", path: ["kits", i, "source", "commit"] });
  });

export type HostedKitDescriptor = z.infer<typeof HostedKitDescriptorSchema>;
export type HostedCatalog = z.infer<typeof HostedCatalogSchema>;

// ---- events -------------------------------------------------------------

const Iso = z.string().datetime({ offset: true });
const Nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable();

export const ActorViewSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), agent: z.string(), onBehalfOf: z.string() }).strict(),
  /** `platform-proposal`: on codespar-test the run's actor forwarded the kit's approval to a platform proposal; that authorizes no payment. */
  z.object({ type: z.literal("human"), id: z.string(), channel: z.enum(["playground", "platform-proposal"]) }).strict(),
  z.object({ type: z.literal("mandate"), id: z.string() }).strict(),
]);

export const EvidenceRefSchema = z.object({ kind: EvidenceKindSchema, id: Nullable(z.string()), detail: Nullable(z.string()) }).strict();

/** Ids only. A payee key, a credential, a signature or a card number is never a reference. */
export const SafeRefSchema = z
  .object({
    turnId: z.string(),
    toolCallId: z.string(),
    executionId: z.string(),
    batchRef: z.string(),
    attemptId: z.string(),
    approvalId: z.string(),
    receiptId: z.string(),
    chargeId: z.string(),
    proposalId: z.string(),
  })
  .partial()
  .strict();

export const ItemViewSchema = z
  .object({
    beneficiary: z.string(),
    payeeMasked: z.string().refine((p) => p === "*" || p.includes("***"), "payees travel masked"),
    alias: Nullable(z.string()),
    amountMinor: z.number().int(),
    description: Nullable(z.string()),
    dueDate: Nullable(z.string()),
  })
  .strict();

export const ApprovalBindingSchema = z
  .object({
    itemsHash: z.string().regex(HASH),
    totalMinor: z.number().int(),
    currency: z.literal("BRL"),
    mandateId: z.string(),
    mandateVersion: z.number().int().positive(),
    batchHash: Nullable(z.string().regex(HASH)),
    batchIndex: Nullable(z.number().int().nonnegative()),
    compositionHash: Nullable(z.string().regex(HASH)),
  })
  .strict();

export const ExecutionViewSchema = z
  .object({
    id: z.string().regex(/^exe_/),
    state: ExecutionStateSchema,
    reason: Nullable(z.string()),
    detail: Nullable(z.string()),
    approvalMode: ApprovalModeSchema,
    items: z.array(ItemViewSchema).nonempty(),
    totalMinor: z.number().int(),
    currency: z.literal("BRL"),
    itemsHash: z.string().regex(HASH),
    batch: Nullable(z.object({ ref: z.string(), batchHash: z.string().regex(HASH), index: z.number().int().nonnegative(), count: z.number().int().positive() }).strict()),
    compositionHash: Nullable(z.string().regex(HASH)),
    escalation: Nullable(z.object({ trigger: z.string(), detail: z.string() }).strict()),
    approvalId: Nullable(z.string()),
    approvedBy: Nullable(ActorViewSchema),
    attempts: z.array(z.object({ attemptId: z.string(), status: z.enum(["accepted", "settled", "failed", "uncertain"]), code: Nullable(z.string()), message: Nullable(z.string()) }).strict()),
    evidence: z.array(EvidenceRefSchema),
    history: z.array(z.object({ from: ExecutionStateSchema, to: ExecutionStateSchema, at: Iso, reason: Nullable(z.string()), actor: ActorViewSchema }).strict()),
    createdAt: Iso,
    updatedAt: Iso,
  })
  .strict();

const BatchLineSchema = z
  .object({ index: z.number().int().nonnegative(), beneficiary: z.string(), amountMinor: z.number().int(), executionId: Nullable(z.string()), state: z.string(), reason: Nullable(z.string()), evidence: z.array(EvidenceRefSchema) })
  .strict();

export const BatchViewSchema = z
  .object({ batchRef: z.string(), label: z.string(), batchHash: z.string().regex(HASH), count: z.number().int().positive(), totalMinor: z.number().int(), settledMinor: z.number().int(), lines: z.array(BatchLineSchema) })
  .strict();

export const InstrumentViewSchema = z
  .object({ payable: z.boolean(), status: z.string(), dueDate: Nullable(z.string()), pixCopyPaste: Nullable(z.string()), boletoLine: Nullable(z.string()), consentUrl: Nullable(z.string()) })
  .strict();

const RunKitRefSchema = z.object({ id: z.string(), version: z.string(), commit: z.string().regex(COMMIT), packageDigest: z.string().regex(DIGEST) }).strict();
const RuleSchema = z.object({ approvalMode: ApprovalModeSchema, trigger: Nullable(z.string()), detail: Nullable(z.string()) }).strict();

const EventData = {
  "run.created": z
    .object({ kit: RunKitRefSchema, modelMode: ModelModeSchema, executor: ExecutorIdSchema, approvalMode: ApprovalModeSchema, locale: LocaleNameSchema, exampleId: Nullable(z.string()), inputRevision: z.string().regex(HASH) })
    .strict(),
  "turn.accepted": z.object({ turnId: z.string(), index: z.number().int().nonnegative(), text: z.string(), origin: z.enum(["typed", "example"]) }).strict(),
  "turn.refused": z
    .object({ reason: z.enum(["run_stopped", "run_busy", "replay_exhausted", "replay_requires_example_turn", "pending_decision"]), detail: Nullable(z.string()) })
    .strict(),
  "tool.started": z.object({ toolCallId: z.string(), name: z.string(), effect: ToolEffectSchema }).strict(),
  "tool.completed": z.object({ toolCallId: z.string(), name: z.string(), effect: ToolEffectSchema, refused: z.boolean(), error: Nullable(z.string()) }).strict(),
  "assistant.replied": z.object({ turnId: z.string(), text: z.string(), truncated: z.boolean() }).strict(),
  "execution.proposed": ExecutionViewSchema,
  "execution.transitioned": z.object({ from: ExecutionStateSchema, to: ExecutionStateSchema, reason: Nullable(z.string()), detail: Nullable(z.string()), actor: ActorViewSchema }).strict(),
  "batch.presented": BatchViewSchema,
  "approval.requested": z
    .object({ binding: ApprovalBindingSchema, rule: RuleSchema, canApprove: z.boolean(), blockingReasons: z.array(z.string()), expiresAt: Nullable(Iso) })
    .strict(),
  "approval.decided": z.object({ decision: z.enum(["approve", "deny", "forward"]), actor: ActorViewSchema, approvalId: Nullable(z.string()), resultState: ExecutionStateSchema }).strict(),
  "batch.decided": z
    .object({ batchHash: z.string().regex(HASH), count: z.number().int().positive(), approved: z.array(z.number().int().nonnegative()), vetoed: z.array(z.number().int().nonnegative()), actor: ActorViewSchema })
    .strict(),
  "dispatch.attempted": z.object({ attemptId: z.string(), idempotencyKey: z.string(), amountMinor: z.number().int(), payeeMasked: z.string(), rail: z.string() }).strict(),
  "outcome.pending": z.object({ kind: z.enum(["uncertain", "awaiting_payer", "needs_human", "awaiting_proposal"]), detail: z.string() }).strict(),
  /** codespar-test: the platform proposal of one attempt, each time its observed state changes. */
  "proposal.updated": z.object({ proposalId: z.string(), attemptId: z.string(), state: z.enum(["drafted", "awaiting_approval", "executing", "succeeded", "failed", "denied"]) }).strict(),
  "instrument.presented": z
    .object({
      chargeId: z.string(),
      instalment: z.number().int().nonnegative(),
      payable: z.boolean(),
      status: z.string(),
      dueDate: Nullable(z.string()),
      pixCopyPaste: Nullable(z.string()),
      boletoLine: Nullable(z.string()),
      consentUrl: Nullable(z.string()),
    })
    .strict(),
  "outcome.confirmed": z.object({ state: z.enum(["settled", "failed", "denied", "expired"]), reason: Nullable(z.string()), evidence: z.array(EvidenceRefSchema) }).strict(),
  "line.not_run": z.object({ ref: z.string(), why: z.enum(["already_settled", "in_progress", "refused"]), detail: Nullable(z.string()) }).strict(),
  "result.verified": z.object({ receiptId: z.string(), verified: z.boolean(), keyId: Nullable(z.string()), detail: Nullable(z.string()) }).strict(),
  "run.interrupted": z.object({ detail: z.string(), danglingToolCalls: z.array(z.string()) }).strict(),
  "run.resumed": z
    .object({ reconciled: z.array(z.object({ executionId: z.string(), from: ExecutionStateSchema, to: ExecutionStateSchema }).strict()), expired: z.array(z.string()), open: z.array(z.string()) })
    .strict(),
  "run.stopped": z.object({ actor: ActorViewSchema, reason: Nullable(z.string()), deniedOpen: z.array(z.string()), stillExecuting: z.array(z.string()) }).strict(),
  /** What the kit tells the counterparty about an outcome (`kit.announceOutcome`), once per outcome. In the Playground the person plays both sides. */
  "counterparty.message": z.object({ text: z.string() }).strict(),
} as const;

export type HostedEventType = keyof typeof EventData;
export const HOSTED_EVENT_TYPES = Object.keys(EventData) as HostedEventType[];
export type EventSource = "host" | "loop" | "engine" | "kit";

const EVENT_SOURCE: Record<HostedEventType, EventSource> = {
  "run.created": "host",
  "turn.accepted": "host",
  "turn.refused": "host",
  "tool.started": "loop",
  "tool.completed": "loop",
  "assistant.replied": "loop",
  "execution.proposed": "engine",
  "execution.transitioned": "engine",
  "batch.presented": "loop",
  "approval.requested": "engine",
  "approval.decided": "host",
  "batch.decided": "host",
  "dispatch.attempted": "engine",
  "outcome.pending": "engine",
  "instrument.presented": "engine",
  "outcome.confirmed": "engine",
  "line.not_run": "loop",
  "result.verified": "host",
  "run.interrupted": "host",
  "run.resumed": "host",
  "run.stopped": "host",
  "counterparty.message": "kit",
  "proposal.updated": "engine",
};

const EnvelopeSchema = z
  .object({
    v: z.literal(1),
    runId: z.string().regex(RUN_ID),
    seq: z.number().int().positive(),
    at: Iso,
    type: z.enum(HOSTED_EVENT_TYPES as [HostedEventType, ...HostedEventType[]]),
    source: z.enum(["host", "loop", "engine", "kit"]),
    ref: SafeRefSchema.optional(),
    data: z.unknown(),
  })
  .strict();

export const HostedEventSchema = EnvelopeSchema.superRefine((e, ctx) => {
  if (EVENT_SOURCE[e.type] !== e.source) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${e.type} comes from ${EVENT_SOURCE[e.type]}`, path: ["source"] });
  const parsed = EventData[e.type].safeParse(e.data);
  if (!parsed.success) for (const i of parsed.error.issues) ctx.addIssue({ ...i, path: ["data", ...i.path] });
});

export type HostedEvent<T extends HostedEventType = HostedEventType> = {
  v: 1;
  runId: string;
  seq: number;
  at: string;
  type: T;
  source: EventSource;
  ref?: z.infer<typeof SafeRefSchema>;
  data: z.infer<(typeof EventData)[T]>;
};

/** A log as a host serves it: one run, `seq` from 1 (or from `after + 1`) with no gap. */
export function checkEventLog(events: readonly HostedEvent[], after = 0): string[] {
  const problems: string[] = [];
  const runIds = new Set(events.map((e) => e.runId));
  if (runIds.size > 1) problems.push(`one run per log, found ${[...runIds].join(", ")}`);
  events.forEach((e, i) => {
    if (e.seq !== after + i + 1) problems.push(`seq ${e.seq} at position ${i}; expected ${after + i + 1}`);
    const parsed = HostedEventSchema.safeParse(e);
    if (!parsed.success) problems.push(`seq ${e.seq} (${e.type}): ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
  });
  return problems;
}

// ---- snapshot -----------------------------------------------------------

export const RunStatusSchema = z.enum(["idle", "running", "awaiting_decision", "awaiting_payer", "awaiting_reconciliation", "interrupted", "stopped"]);

export const PendingActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("decision"),
      executionId: z.string(),
      binding: ApprovalBindingSchema,
      items: z.array(ItemViewSchema).nonempty(),
      rule: RuleSchema,
      canApprove: z.boolean(),
      blockingReasons: z.array(z.string()),
      expiresAt: Nullable(Iso),
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch_decision"),
      batchRef: z.string(),
      batchHash: z.string().regex(HASH),
      count: z.number().int().positive(),
      totalMinor: z.number().int(),
      lines: z.array(z.object({ index: z.number().int().nonnegative(), executionId: Nullable(z.string()), beneficiary: z.string(), amountMinor: z.number().int(), status: z.string() }).strict()),
    })
    .strict(),
  z.object({ kind: z.literal("payer"), executionId: z.string(), chargeId: z.string(), instalment: z.number().int().nonnegative(), instrument: InstrumentViewSchema, simulatable: z.boolean() }).strict(),
  z.object({ kind: z.literal("reconciliation"), executionId: z.string(), detail: z.string() }).strict(),
  /** codespar-test: a platform proposal a person pays (`/v1/proposals/:id/pay`) or Aprovações decides. Not decided through the run. */
  z
    .object({ kind: z.literal("payment_proposal"), executionId: z.string(), proposalId: z.string(), proposalState: z.enum(["drafted", "awaiting_approval", "executing"]) })
    .strict(),
]);

export const RunSnapshotSchema = z
  .object({
    v: z.literal(1),
    run: z
      .object({
        id: z.string().regex(RUN_ID),
        kit: RunKitRefSchema,
        modelMode: ModelModeSchema,
        executor: ExecutorIdSchema,
        approvalMode: ApprovalModeSchema,
        locale: LocaleNameSchema,
        exampleId: Nullable(z.string()),
        inputRevision: z.string().regex(HASH),
        status: RunStatusSchema,
        createdAt: Iso,
        updatedAt: Iso,
      })
      .strict(),
    cursor: z.object({ seq: z.number().int().nonnegative() }).strict(),
    pending: z.array(PendingActionSchema),
    executions: z.array(ExecutionViewSchema),
    batches: z.array(BatchViewSchema),
    turns: z.array(
      z
        .object({
          turnId: z.string(),
          index: z.number().int().nonnegative(),
          text: z.string(),
          reply: Nullable(z.string()),
          tools: z.array(z.object({ toolCallId: z.string(), name: z.string(), effect: z.string(), refused: z.boolean() }).strict()),
          interrupted: z.boolean(),
        })
        .strict(),
    ),
    notRun: z.array(z.object({ ref: z.string(), why: z.string(), detail: Nullable(z.string()) }).strict()),
    replay: Nullable(z.object({ exampleId: z.string(), turnsTotal: z.number().int().positive(), turnsDone: z.number().int().nonnegative(), nextTurnText: Nullable(z.string()) }).strict()),
  })
  .strict()
  .superRefine((s, ctx) => {
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const byId = new Map(s.executions.map((e) => [e.id, e]));
    for (const [i, p] of s.pending.entries()) {
      if (p.kind === "decision") {
        const e = byId.get(p.executionId);
        if (!e || e.state !== "awaiting_approval") issue("a decision is pending only on an execution awaiting approval", ["pending", i]);
        else if (e.batch) issue("a batch line is decided through its batch_decision", ["pending", i]);
        else if (e.itemsHash !== p.binding.itemsHash || e.totalMinor !== p.binding.totalMinor) issue("the binding is the execution's own", ["pending", i, "binding"]);
      }
    }
    const waits = s.pending.some((p) => p.kind === "decision" || p.kind === "batch_decision" || p.kind === "payment_proposal");
    if (waits && s.run.status !== "awaiting_decision" && s.run.status !== "stopped") issue("a pending decision means status awaiting_decision", ["run", "status"]);
    if (s.run.status === "running" && s.pending.some((p) => p.kind === "decision" || p.kind === "batch_decision")) issue("nothing is actionable while running", ["pending"]);
  });

export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export type PendingAction = z.infer<typeof PendingActionSchema>;
export type ExecutionView = z.infer<typeof ExecutionViewSchema>;
export type BatchView = z.infer<typeof BatchViewSchema>;
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;
export type ActorView = z.infer<typeof ActorViewSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
