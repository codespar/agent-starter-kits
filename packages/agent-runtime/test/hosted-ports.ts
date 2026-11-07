/**
 * In-memory ports for the hosted channel's tests: what a host provides, with
 * the failure a host must survive (a process that dies between two saves)
 * available on demand. Nothing here is a production adapter.
 */
import { randomBytes } from "node:crypto";
import { hmacSigner, type AgentRuntime, type ConversationMessage, type Reply, type ToolCall, type ToolSpec } from "@codespar/agent-core";
import { loadAgent } from "../src/agent.js";
import { describeKit } from "../src/hosted/catalog.js";
import type { HostedEvent } from "../src/hosted/contract.js";
import { FencedError, type ProposalRail, type ProposalState } from "../src/hosted/proposals.js";
import type { ApprovalPort, HostedActor, HostedKit, HostedPorts, IdentityPort, ModelPort, RailPort, RunImage, StatePort } from "../src/hosted/run.js";

export const ACTOR: HostedActor = { userId: "user_fixture_owner", orgId: "org_fixture", projectId: "prj_fixture", environment: "test" };

/** A durable store with compare-and-set, an append-only event log, and a switch that makes the next save die like a killed process. */
export class MemoryState implements StatePort {
  private readonly rows = new Map<string, { image: string; revision: number }>();
  readonly log = new Map<string, HostedEvent[]>();
  saves = 0;
  /** Set to n: the n-th save from now throws, and nothing of it is kept. */
  dieOnSave: number | undefined;
  /** The lease epoch the host holds now. A process whose epoch is older is refused, as the host's lease would refuse it. */
  epoch = 1;

  /** This store as a process holding `epoch` sees it: its saves are refused with `lease_lost` once a newer epoch took the run. */
  forEpoch(epoch: number): StatePort {
    return {
      load: (runId) => this.load(runId),
      save: async (runId, image, newEvents, expected) => (epoch < this.epoch ? { ok: false as const, reason: "lease_lost" as const } : this.save(runId, image, newEvents, expected)),
      events: (runId, after) => this.events(runId, after),
    };
  }

  async load(runId: string) {
    const row = this.rows.get(runId);
    return row ? { image: JSON.parse(row.image) as RunImage, revision: row.revision } : undefined;
  }

  async save(runId: string, image: RunImage, newEvents: readonly HostedEvent[], expectedRevision: number) {
    if (this.dieOnSave !== undefined) {
      this.dieOnSave -= 1;
      if (this.dieOnSave === 0) {
        this.dieOnSave = undefined;
        throw new Error("simulated crash: the process died during a save");
      }
    }
    const current = this.rows.get(runId)?.revision ?? 0;
    if (current !== expectedRevision) return { ok: false as const, reason: "revision_conflict" as const };
    this.rows.set(runId, { image: JSON.stringify(image), revision: current + 1 });
    this.log.set(runId, [...(this.log.get(runId) ?? []), ...structuredClone(newEvents)]);
    this.saves += 1;
    return { ok: true as const, revision: current + 1 };
  }

  async events(runId: string, after: number) {
    return (this.log.get(runId) ?? []).filter((e) => e.seq > after);
  }
}

/** The platform's proposals as the host would offer them: one per attempt, by id; paid or refused only when a test says so. */
export class FakeProposals implements ProposalRail {
  readonly submitted: Array<Parameters<ProposalRail["submit"]>[0]> = [];
  private readonly states = new Map<string, { state: ProposalState; receiptId: string | null; failureCode: string | null }>();
  async submit(request: Parameters<ProposalRail["submit"]>[0]) {
    const proposalId = `prop_${request.attemptId}`;
    if (!this.states.has(proposalId)) {
      this.submitted.push(structuredClone(request));
      this.states.set(proposalId, { state: "awaiting_approval", receiptId: null, failureCode: null });
    }
    return { proposalId, state: this.states.get(proposalId)!.state };
  }
  async read(proposalId: string) {
    const found = this.states.get(proposalId);
    if (!found) throw new Error(`no proposal ${proposalId}`);
    return found;
  }
  /** A verified person paid it, and the platform sealed a receipt. */
  pay(proposalId: string, receiptId: string): void {
    this.states.set(proposalId, { state: "succeeded", receiptId, failureCode: null });
  }
  /** The proposal port as a process holding `epoch` sees it: fenced once `fencedBelow` is above that epoch. */
  fencedBelow = 0;
  forEpoch(epoch: number): ProposalRail {
    const fence = () => {
      if (epoch < this.fencedBelow) throw new FencedError("lease_lost");
    };
    return {
      submit: async (request) => (fence(), this.submit(request)),
      read: async (proposalId) => (fence(), this.read(proposalId)),
    };
  }

  /** Aprovações or the person refused it. */
  deny(proposalId: string): void {
    this.states.set(proposalId, { state: "denied", receiptId: null, failureCode: null });
  }
}

/** A model that answers from a script, the way a configured model would answer through the host's adapter. */
export class ScriptedRuntime implements AgentRuntime {
  readonly name = "scripted";
  readonly seen: ConversationMessage[][] = [];
  /** The system prompt of each step, as the model received it. */
  readonly systems: string[] = [];
  /** The tools of each step, as the model received them. */
  readonly tools: ToolSpec[][] = [];
  constructor(private readonly steps: Array<ToolCall[] | Reply>) {}
  async step(input: { system: string; messages: ConversationMessage[] }, tools: ToolSpec[] = []): Promise<ToolCall[] | Reply> {
    this.seen.push(structuredClone(input.messages));
    this.systems.push(input.system);
    this.tools.push(structuredClone(tools));
    const next = this.steps.shift();
    if (!next) throw new Error("the scripted model has nothing more to say");
    return next;
  }
}

export interface PortOptions {
  state?: MemoryState;
  actor?: HostedActor;
  rail?: RailPort;
  model?: ModelPort;
  config?: Record<string, string>;
  authorize?: ApprovalPort["authorize"];
  clock?: () => Date;
}

export function ports(options: PortOptions = {}): HostedPorts & { state: MemoryState; decisions: Array<{ executionId: string; decision: string }> } {
  const decisions: Array<{ executionId: string; decision: string }> = [];
  const identity: IdentityPort = { actor: async () => options.actor ?? ACTOR };
  const approval: ApprovalPort = {
    signer: hmacSigner("host-test-key", randomBytes(32)),
    authorize:
      options.authorize ??
      (async (request) => {
        decisions.push({ executionId: request.executionId, decision: request.decision });
        return { ok: true };
      }),
  };
  return {
    identity,
    state: options.state ?? new MemoryState(),
    approval,
    rail: options.rail ?? { executor: "simulator" },
    model: options.model ?? { mode: "replay" },
    ...(options.config ? { config: options.config } : {}),
    clock: options.clock ?? (() => new Date("2026-09-23T14:00:00-03:00")),
    decisions,
  };
}

export async function hostedKit(dir: string, root: string): Promise<HostedKit> {
  const agent = await loadAgent(dir);
  return { agent, descriptor: describeKit(agent, { root, commit: "c".repeat(40), shared: ["packages/agent-core/src", "packages/agent-runtime/src"] }) };
}
