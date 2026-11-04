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
