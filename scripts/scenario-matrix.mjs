#!/usr/bin/env node
/**
 * Section 12: every scenario of every agent, in every mode it declares, run
 * through the deterministic path — the replay provider and the stub rail, no
 * model, no network, no key — with one row each.
 *
 * What makes a row fail is the FINAL STATE, never the wording: the check is
 * `checkScenario`, which compares the states, the trails, the reasons, the
 * escalation triggers and the receipt counts the scenario declares. An agent
 * that refuses politely and still reaches `executing` fails here; one that
 * says it differently does not.
 *
 * Agents are discovered, not listed: a directory under `agents/` with an
 * `agent.yaml` and a `scenarios/` folder is in the matrix from the moment it
 * lands, which is how a fourth agent gets this gate without touching CI.
 *
 * Usage: node scripts/scenario-matrix.mjs [--json] [--agent <slug>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "packages/agent-runtime/bin.mjs");
const AGENTS_DIR = join(ROOT, "agents");

/**
 * The section 12 table, minus `partial-batch-failure`: that one is the
 * `supplier-payments-agent`'s and lives in another lane. The table is printed
 * as coverage, not enforced — a read-only agent has no cap to exceed and no
 * mandate to revoke, so a missing row there is correct, and the gate is the
 * final state of the scenarios an agent DOES declare.
 */
const SECTION_12 = ["happy-path", "cap-exceeded", "beneficiary-not-allowed", "charge-expired", "prompt-injection", "escalated-above-threshold", "mandate-revoked"];

function agents() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(AGENTS_DIR, e.name, "agent.yaml")))
    .map((e) => ({ slug: e.name, dir: join(AGENTS_DIR, e.name) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function scenarios(agent) {
  const dir = join(agent.dir, "scenarios");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One process per scenario: every mode it declares, on the stub rail, with the clock the scenario pins. */
function runScenario(agent, scenario) {
  const result = spawnSync(process.execPath, [BIN, "start", "--agent", agent.dir, "--scenario", scenario.name, "--json"], {
    cwd: ROOT,
    // No key of either kind: the replay provider and the stub rail are the whole world here.
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "" },
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.error) return { error: String(result.error.message ?? result.error), rows: [] };
  const line = (result.stdout ?? "").split("\n").filter(Boolean).pop();
  if (!line) return { error: `no JSON on stdout (exit ${result.status})\n${(result.stderr ?? "").trim()}`, rows: [] };
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return { error: `stdout was not JSON (exit ${result.status}): ${line.slice(0, 200)}`, rows: [] };
  }
  const rows = (payload.results ?? []).map((r) => ({
    mode: r.mode,
    ok: r.ok === true,
    failures: r.failures ?? [],
    states: (r.run?.executions ?? []).map((e) => e.state),
    receipts: r.run?.receipts ?? 0,
    run_id: r.run?.run_id ?? null,
  }));
  return { error: null, rows };
}

function main(argv) {
  const json = argv.includes("--json");
  const only = argv.includes("--agent") ? argv[argv.indexOf("--agent") + 1] : undefined;
  const say = (line) => process.stderr.write(line + "\n");
  const matrix = [];
  let failures = 0;

  for (const agent of agents()) {
    if (only && only !== agent.slug) continue;
    for (const scenario of scenarios(agent)) {
      const rails = scenario.rails ?? ["stub", "api"];
      if (!rails.includes("stub")) {
        // Not a gap: a scenario that needs a real rail cannot be deterministic, and CI has no key.
        matrix.push({ agent: agent.slug, scenario: scenario.name, mode: null, ok: true, skipped: "needs a real rail; CI has no key", states: [], failures: [] });
        say(`skip ${agent.slug}/${scenario.name} — needs a real rail`);
        continue;
      }
      const { error, rows } = runScenario(agent, scenario);
      if (error) {
        failures += 1;
        matrix.push({ agent: agent.slug, scenario: scenario.name, mode: null, ok: false, states: [], failures: [error] });
        say(`FAIL ${agent.slug}/${scenario.name} — ${error}`);
        continue;
      }
      if (!rows.length) {
        failures += 1;
        matrix.push({ agent: agent.slug, scenario: scenario.name, mode: null, ok: false, states: [], failures: ["the scenario declared no mode to run"] });
        say(`FAIL ${agent.slug}/${scenario.name} — no mode ran`);
        continue;
      }
      for (const row of rows) {
        if (!row.ok) failures += 1;
        matrix.push({ agent: agent.slug, scenario: scenario.name, ...row });
        say(`${row.ok ? "ok  " : "FAIL"} ${agent.slug}/${scenario.name} [${row.mode}] — states ${JSON.stringify(row.states)}, ${row.receipts} receipt(s)${row.failures.length ? ` — ${row.failures.join("; ")}` : ""}`);
      }
    }
  }

  say("");
  say("section 12 coverage (partial-batch-failure belongs to supplier-payments-agent, another lane):");
  for (const agent of agents()) {
    if (only && only !== agent.slug) continue;
    const declared = new Set(scenarios(agent).map((s) => s.name));
    const have = SECTION_12.filter((name) => declared.has(name));
    const extra = [...declared].filter((name) => !SECTION_12.includes(name)).sort();
    say(`  ${agent.slug}: ${have.length}/${SECTION_12.length} of the table${extra.length ? ` (+ ${extra.join(", ")})` : ""} — missing: ${SECTION_12.filter((n) => !declared.has(n)).join(", ") || "none"}`);
  }

  const ran = matrix.filter((r) => !r.skipped).length;
  say("");
  say(failures ? `scenario matrix FAILED: ${failures} of ${ran} run(s)` : `scenario matrix ok: ${ran} run(s) across ${new Set(matrix.map((r) => r.agent)).size} agent(s), every final state as declared`);
  if (json) process.stdout.write(JSON.stringify({ ok: failures === 0, runs: ran, failures, matrix }) + "\n");
  return failures === 0 ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
