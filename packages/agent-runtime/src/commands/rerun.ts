/**
 * `codespar-agent rerun <run-id> [--json]`: replays a recorded run against
 * the deterministic provider and the stub rail, with no network, in a fresh
 * state, and compares the sequence of states with the original bundle. The
 * model's outputs are the recording; every decision of the core is recomputed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stderr, stdout } from "node:process";
import { isLocale, type ApprovalMode, type Execution } from "@codespar/agent-core";
import type { Agent } from "../agent.js";
import { setup } from "../setup.js";
import { openRun } from "../runs.js";
import { handleExecution } from "../terminal.js";

export async function rerun(agent: Agent, argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const runId = argv.find((a) => !a.startsWith("--"));
  const say = (l: string) => stderr.write(l + "\n");
  if (!runId) {
    say("usage: npm run rerun <run-id> [--json]");
    return 2;
  }
  const found = openRun(agent, runId);
  const original = found?.bundle;
  if (!found || !original) {
    say(`no bundle at runs/${runId}`);
    return 1;
  }
  const meta = original.readMeta() ?? {};
  const mode = (meta["mode"] as ApprovalMode | undefined) ?? "human";
  const events = original.readEvents();
  const transitions = events.filter((e) => e["type"] === "execution.transition").map((e) => ({ execution: e["execution_id"] as string, ...(e["payload"] as { from: string; to: string }) }));
  const originalTrail = transitions.map((t) => t.to);
  // What the original did with each approval it asked for, in the order it asked: approved it, denied it, or left it open. A run that stopped at `awaiting_approval` (a one-shot with no --approve or --deny, an adversarial case that only has to escalate) is replayed to the same place, not decided on its behalf.
  const asked = transitions.flatMap((t, i) => (t.to === "awaiting_approval" ? [transitions.slice(i + 1).find((n) => n.execution === t.execution)?.to] : []));
  // Nobody decides an approval that expired either: the rerun's clock does, or the sequences differ and the last line says so.
  const originalDecisions = asked.map((next) => (next === "approved" ? "approve" : next === "denied" ? "deny" : "none"));
  const leftOpen = asked.filter((next) => next === undefined).length;
  const transcript = original.readTranscript();
  // The transcript is the model's side, and replaying it is all a rerun does. A run that never asked the model recorded no step to replay: an adversarial case of `kind: events` drives rail deliveries and writes no transcript at all.
  if (!transcript.some((l) => l.kind === "assistant_step")) {
    const error = `runs/${runId} has no model turn in transcript.jsonl, so there is nothing to replay`;
    if (json) stdout.write(JSON.stringify({ run_id: runId, error }) + "\n");
    say(error);
    return 1;
  }
  const userTurns = transcript.filter((l) => l.kind === "user").map((l) => l["text"] as string);
  const transcriptPath = join(original.dir, "transcript.jsonl");
  const plan = agent.kit.rerunPlan?.(events) ?? {};

  const s = setup(agent, {
    mode,
    rail: "stub",
    provider: "replay",
    transcript: transcriptPath,
    runId: `${original.runId}_rerun_${Date.now().toString(36)}`,
    // Beside the run it replays: the rerun of an eval run stays with the eval runs.
    runsDir: found.runsDir,
    stateDir: mkdtempSync(join(tmpdir(), `${agent.slug}-rerun-`)),
    stubRail: plan.stubRail,
    say,
    // The recording's locale, so the rerun's refusal details read as the original's did.
    ...(isLocale(meta["locale"]) ? { locale: meta["locale"] } : {}),
  });
  try {
    let decisionIndex = 0;
    const runtime = s.makeRuntime();
    const loop = s.makeLoop(runtime, (execution: Execution) => {
      const decision = execution.state === "awaiting_approval" ? (originalDecisions[decisionIndex++] ?? "deny") : "none";
      return handleExecution(execution, {
        setup: s,
        approver: { id: "usr_rerun", channel: "terminal" },
        decision,
        say,
        ...(agent.settlement === "await-payer" ? { tell: () => undefined, simulatePayer: plan.simulatePayer ?? false } : {}),
      });
    });
    for (const text of userTurns) await loop.turn(text);
    const trail = s.store.listEvents({ run_id: s.runId }).filter((e) => e.type === "execution.transition").map((e) => (e.payload as { to: string }).to);
    const outcomesOf = (list: Record<string, unknown>[]) => list.filter((e) => e["type"] === "rail.outcome").map((e) => (e["payload"] as { status: string }).status);
    const originalOutcomes = outcomesOf(events);
    const rerunOutcomes = outcomesOf(s.bundle.readEvents());
    const sameTrail = JSON.stringify(trail) === JSON.stringify(originalTrail);
    const same = agent.kit.rerunComparesOutcomes ? sameTrail && JSON.stringify(rerunOutcomes) === JSON.stringify(originalOutcomes) : sameTrail;
    if (json) {
      stdout.write(
        JSON.stringify({
          run_id: runId,
          rerun_id: s.runId,
          same_states: same,
          original: originalTrail,
          rerun: trail,
          ...(agent.kit.rerunComparesOutcomes ? { original_outcomes: originalOutcomes, rerun_outcomes: rerunOutcomes } : {}),
          bundle_dir: s.bundle.dir,
        }) + "\n",
      );
    }
    const open = leftOpen > 0 ? `; ${leftOpen} execution(s) left in awaiting_approval, as the original left ${leftOpen === 1 ? "it" : "them"}` : "";
    say(same ? `rerun ok: ${trail.length} transition(s), same sequence as ${runId}${open}` : `rerun DIFFERS: original ${JSON.stringify(originalTrail)} vs rerun ${JSON.stringify(trail)}`);
    return same ? 0 : 1;
  } finally {
    s.close();
  }
}
