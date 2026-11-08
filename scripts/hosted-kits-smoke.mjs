#!/usr/bin/env node
/**
 * The hosted-kits tarball, installed the way the API installs it — into an
 * empty project outside this repository, by npm, from the file — and every
 * kit in its catalog run once from its own first example on the simulator,
 * with in-memory ports. What passes is that the artifact alone runs the real
 * modules: no workspace, no TypeScript loader, no file of this checkout.
 *
 * Usage: node scripts/hosted-kits-smoke.mjs <path/to/codespar-hosted-kits-*.tgz>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SMOKE = `
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync as readText } from "node:fs";
import { join as joinPath } from "node:path";
import { checkEventLog, createHostedRun, loadHostedCatalog, openHostedKit, RunSnapshotSchema } from "@codespar/hosted-kits/host";

const key = Buffer.from("hosted-kits-smoke-not-a-secret");
const sign = (payload) => createHmac("sha256", key).update(payload).digest("hex");
const signer = { keyId: "smoke", sign, verify: (payload, signature) => timingSafeEqual(Buffer.from(sign(payload)), Buffer.from(signature)) };
const actor = { userId: "user_smoke", orgId: "org_smoke", projectId: "prj_smoke", environment: "test" };

function memoryState() {
  const rows = new Map();
  const log = new Map();
  return {
    log,
    async load(runId) { const r = rows.get(runId); return r ? { image: JSON.parse(r.image), revision: r.revision } : undefined; },
    async save(runId, image, events, expected) {
      const current = rows.get(runId)?.revision ?? 0;
      if (current !== expected) return { ok: false, reason: "revision_conflict" };
      rows.set(runId, { image: JSON.stringify(image), revision: current + 1 });
      log.set(runId, [...(log.get(runId) ?? []), ...events]);
      return { ok: true, revision: current + 1 };
    },
    async events(runId, after) { return (log.get(runId) ?? []).filter((e) => e.seq > after); },
  };
}

// The API installs the artifact without the model SDKs (optional peers) and must still run every kit.
for (const sdk of ["@anthropic-ai/sdk", "@google/genai"]) {
  let found = true;
  try { await import(sdk); } catch { found = false; }
  if (found) { console.log("FAIL the hosted install pulled " + sdk); process.exit(1); }
}

function memoryProposals() {
  const states = new Map();
  return {
    states,
    async submit(request) { const id = "prop_" + request.attemptId; if (!states.has(id)) states.set(id, { state: "awaiting_approval", receiptId: null, failureCode: null }); return { proposalId: id, state: states.get(id).state }; },
    async read(id) { return states.get(id); },
  };
}

const catalog = loadHostedCatalog();
let failures = 0;
for (const descriptor of catalog.kits) {
  const state = memoryState();
  const ports = { identity: { actor: async () => actor }, state, approval: { signer, authorize: async () => ({ ok: true }) }, rail: { executor: "simulator" }, model: { mode: "replay" }, clock: () => new Date("2026-09-23T14:00:00-03:00") };
  try {
    const kit = await openHostedKit(catalog, descriptor.id, descriptor.source.packageDigest);
    const example = descriptor.examples.find((e) => e.replay && e.id === "happy-path") ?? descriptor.examples.find((e) => e.replay);
    const run = await createHostedRun(kit, ports, { commandId: "create", modelMode: "replay", executor: "simulator", options: { exampleId: example.id } });
    for (let n = 0; n < example.turns.length; n += 1) await run.turn({ commandId: "turn-" + n, exampleTurn: n });
    let snapshot = await run.snapshot();
    for (let round = 0; round < 4 && snapshot.pending.length > 0; round += 1) {
      const p = snapshot.pending[0];
      if (p.kind === "decision") snapshot = await run.decide({ commandId: "d" + round, executionId: p.executionId, decision: "approve", binding: p.binding });
      else if (p.kind === "batch_decision") snapshot = await run.decideBatch({ commandId: "d" + round, batchRef: p.batchRef, batchHash: p.batchHash, count: p.count, vetoed: [] });
      else if (p.kind === "payer" && p.simulatable) snapshot = await run.simulatePayer({ commandId: "p" + round, executionId: p.executionId, behaviour: "pays" });
      else break;
    }
    const parsed = RunSnapshotSchema.safeParse(snapshot);
    const problems = [...(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join(".") + " " + i.message)), ...checkEventLog(state.log.get(run.runId) ?? [])];
    if (problems.length) throw new Error(problems.slice(0, 5).join("; "));
    console.log("ok   " + descriptor.id + " [" + example.id + "] " + snapshot.run.status + ": " + (snapshot.executions.map((e) => e.state).join(", ") || "no execution") + " (" + snapshot.cursor.seq + " events)");
  } catch (err) {
    failures += 1;
    console.log("FAIL " + descriptor.id + ": " + (err instanceof Error ? err.message : String(err)));
  }
}
// codespar-test, against IN-MEMORY stand-ins of the host's ports (a SIMULATION, not the platform): every runnable kit
// drafts proposals and pays nothing; a proposal the stand-in marks paid reads back settled.
for (const descriptor of catalog.kits) {
  const executor = descriptor.executors.find((e) => e.id === "codespar-test");
  if (!executor || executor.blockedBy.length > 0) continue;
  const state = memoryState();
  const proposals = memoryProposals();
  // SIMULATION of the host's read port (v1.5), for a read-only kit: fixed answers, counted.
  const readCalls = [];
  const reads = {
    async balance() { readCalls.push("balance"); return { environment: "test", asOf: "2026-11-08T12:00:00.000Z", accountExists: true, currencies: [{ currency: "BRL", balanceMinor: 1000, availableMinor: 1000, heldMinor: 0 }] }; },
    async mandates() { readCalls.push("mandates"); return []; },
    async proposals() { readCalls.push("proposals"); return []; },
  };
  const ports = { identity: { actor: async () => actor }, state, approval: { signer, authorize: async () => ({ ok: true }) }, rail: { executor: "codespar-test", proposals, reads }, model: { mode: "replay" }, clock: () => new Date("2026-09-23T14:00:00-03:00") };
  try {
    const kit = await openHostedKit(catalog, descriptor.id, descriptor.source.packageDigest);
    if (executor.requires.includes("platform.consent_pulls")) {
      // A pull kit (v1.7), against an IN-MEMORY stand-in of the host's pull port (a SIMULATION: no platform, no bank): the
      // kit's own example mandate, re-pointed at one consented account; one pull per attempt; signed only when this says so.
      const payee = "fs_smoke_own_account";
      const base = JSON.parse(readText(joinPath(kit.agent.dir, "mandate.example.json"), "utf8"));
      const mandate = { ...base, id: "consent_smoke", source: "consent", merchant_allowlist: [payee], beneficiaries: [{ ...base.beneficiaries[0], payee }] };
      const pulls = new Map();
      const sent = [];
      const pullPort = {
        async submit(request) {
          const id = "swp_" + request.attemptId.slice(-12);
          if (request.payee !== payee) return { ok: false, code: "payee_not_consented", message: "one account only" };
          if (!pulls.has(id)) { sent.push(id); pulls.set(id, { state: "pending", endToEndId: null, code: null, needsHuman: false, signatureTimedOut: false }); }
          return { ok: true, pullId: id, state: pulls.get(id).state };
        },
        async read(id) { return pulls.get(id); },
      };
      const run = await createHostedRun(kit, { ...ports, rail: { executor: "codespar-test", pulls: pullPort, mandate } }, { commandId: "create", modelMode: "replay", executor: "codespar-test", options: { exampleId: "happy-path" } });
      const example = descriptor.examples.find((e) => e.id === "happy-path");
      for (let n = 0; n < example.turns.length; n += 1) await run.turn({ commandId: "turn-" + n, exampleTurn: n });
      let snapshot = await run.snapshot();
      const waiting = snapshot.pending.filter((p) => p.kind === "payer" && p.instrument.consentUrl === null && !p.simulatable);
      if (waiting.length === 0 || proposals.states.size > 0) throw new Error("no pull waiting for the person, or a proposal drafted: " + JSON.stringify(snapshot.pending));
      for (const id of sent) pulls.set(id, { state: "completed", endToEndId: "E00000000SMOKE" + id.slice(-8), code: null, needsHuman: false, signatureTimedOut: false });
      snapshot = await run.resume({ commandId: "resume" });
      await run.resume({ commandId: "resume-again" });
      if (snapshot.executions.some((e) => e.state !== "settled") || sent.length !== waiting.length) throw new Error("not settled once each after the pulls were signed: " + snapshot.executions.map((e) => e.state).join(", ") + ", " + sent.length + " sent");
      console.log("ok   " + descriptor.id + " [codespar-test] " + sent.length + " pull(s) under the consent, signed in the in-memory stand-in of the platform (SIMULATION), " + snapshot.executions.length + " settled, 0 proposals");
      continue;
    }
    if (!descriptor.needsMandate) {
      // A read-only kit: its recommended example reads through the port, and nothing is proposed or executed.
      const exampleId = descriptor.recommendedRuns[0]?.example ?? "happy-path";
      const run = await createHostedRun(kit, ports, { commandId: "create", modelMode: "replay", executor: "codespar-test", options: { exampleId } });
      const example = descriptor.examples.find((e) => e.id === exampleId);
      for (let n = 0; n < example.turns.length; n += 1) await run.turn({ commandId: "turn-" + n, exampleTurn: n });
      const snapshot = await run.snapshot();
      if (snapshot.executions.length > 0 || proposals.states.size > 0) throw new Error("a read-only kit proposed or executed something");
      if (readCalls.length === 0) throw new Error("the read-only kit read nothing through the port");
      console.log("ok   " + descriptor.id + " [codespar-test] read-only: " + readCalls.join(", ") + "; 0 proposals, 0 executions");
      continue;
    }
    const example = descriptor.examples.find((e) => e.replay && e.id === "happy-path") ?? descriptor.examples.find((e) => e.replay);
    const run = await createHostedRun(kit, ports, { commandId: "create", modelMode: "replay", executor: "codespar-test", options: { exampleId: example.id } });
    for (let n = 0; n < example.turns.length; n += 1) await run.turn({ commandId: "turn-" + n, exampleTurn: n });
    let snapshot = await run.snapshot();
    const waiting = snapshot.pending.filter((p) => p.kind === "payment_proposal");
    if (waiting.length === 0) throw new Error("no proposal drafted: " + JSON.stringify(snapshot.pending));
    for (const p of waiting) proposals.states.set(p.proposalId, { state: "succeeded", receiptId: "rcpt_smoke_" + p.proposalId, failureCode: null });
    snapshot = await run.resume({ commandId: "resume" });
    if (snapshot.executions.some((e) => e.state !== "settled")) throw new Error("not settled after the proposals were paid: " + snapshot.executions.map((e) => e.state).join(", "));
    console.log("ok   " + descriptor.id + " [codespar-test] " + waiting.length + " proposal(s), paid by the in-memory stand-in of the platform (SIMULATION), " + snapshot.executions.length + " settled");
  } catch (err) {
    failures += 1;
    console.log("FAIL " + descriptor.id + " [codespar-test]: " + (err instanceof Error ? err.message : String(err)));
  }
}
process.exit(failures ? 1 : 0);
`;

const tgz = process.argv[2];
if (!tgz) {
  process.stderr.write("usage: node scripts/hosted-kits-smoke.mjs <tarball>\n");
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "hosted-kits-smoke-"));
try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "hosted-kits-smoke", private: true, type: "module" }) + "\n");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", resolve(tgz)], { cwd: dir, stdio: "inherit" });
  writeFileSync(join(dir, "smoke.mjs"), SMOKE);
  // No key of any kind in the child: the simulator and the replay are the whole world here.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|CODESPAR_|ANTHROPIC|GEMINI|INICIADOR/.test(name)));
  execFileSync(process.execPath, ["smoke.mjs"], { cwd: dir, stdio: "inherit", env });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
