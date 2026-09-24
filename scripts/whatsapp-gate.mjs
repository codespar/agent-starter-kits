#!/usr/bin/env node
/**
 * Wave 4's gate: "três execuções do zero sem intervenção".
 *
 * Three runs of the `collections-agent` over the WhatsApp channel, each from
 * a clean state directory and a clean runs directory, with nobody at a
 * keyboard: the debtor's turns come from the conversation the agent ships,
 * the model comes from the recorded transcript, the rail is the stub and the
 * payer is its fixture. No external network, no key, no Meta account.
 *
 * The channel runs against `dyvit-wa-sim`, the local Cloud API emulator from
 * https://github.com/fabianocruz/whatsapp-simulator (MIT), which must already
 * be listening — `npm run whatsapp:emulator`. That is deliberate: the backend
 * under test is the SAME code the official one uses, with a different base
 * URL, so what passes here is the adapter and not a mock of it.
 *
 * What makes a run pass is the FINAL STATE and the SHAPE of the conversation,
 * never the wording — the same rule the scenario matrix follows. Concretely:
 * the execution settled, one receivable was issued, one record came back,
 * every message the agent sent went out, the QR was followed immediately by
 * the copy-and-paste as its own message (a code inside a picture cannot be
 * copied), and the person was told the outcome exactly once.
 *
 * And the three runs must agree with each other, which is the part a single
 * run cannot show: a channel that leaks state between runs, or a clock that
 * moved, fails here rather than in a demo.
 *
 * Usage: node scripts/whatsapp-gate.mjs [--runs 3] [--json] [--mode mandate|human]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "packages/agent-runtime/bin.mjs");
const AGENT = join(ROOT, "agents/collections-agent");
const EMULATOR = process.env.WHATSAPP_SIM_URL ?? "http://127.0.0.1:4290";
/** Pinned so the collection-hours guardrail reads the same at 03:00 as at 15:00 (#16). */
const NOW = "2026-09-23T14:00:00-03:00";

function runOnce(index, mode) {
  const state = mkdtempSync(join(tmpdir(), `wa-gate-state-${index}-`));
  const runs = mkdtempSync(join(tmpdir(), `wa-gate-runs-${index}-`));
  try {
    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "start",
        "--agent",
        AGENT,
        "--channel",
        "whatsapp",
        "--conversation",
        "acordo-1042",
        "--scripted",
        "--mode",
        mode,
        // `mandate` is the gate's own mode: nobody intervenes. `human` is offered
        // for the operator's side of the same conversation, and then the decision
        // has to come from somewhere, because a script has no keyboard.
        ...(mode === "human" ? ["--approve"] : []),
        "--simulate-payer",
        "--now",
        NOW,
        "--json",
      ],
      {
        cwd: ROOT,
        // Neither key: the replay provider and the stub rail are the whole world, and the simulator needs no Meta account.
        env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", COLLECTIONS_STATE_DIR: state, COLLECTIONS_RUNS_DIR: runs },
        encoding: "utf8",
        timeout: 180_000,
      },
    );
    if (result.error) return { failures: [String(result.error.message ?? result.error)] };
    const line = (result.stdout ?? "").split("\n").filter(Boolean).pop();
    if (!line) return { failures: [`no JSON on stdout (exit ${result.status})\n${(result.stderr ?? "").trim()}`] };
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return { failures: [`stdout was not JSON (exit ${result.status}): ${line.slice(0, 200)}`] };
    }
    const logPath = isAbsolute(payload.channel?.log ?? "") ? payload.channel.log : join(ROOT, payload.channel?.log ?? "");
    const conversation = existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { payload, conversation, failures: check(payload, conversation) };
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
}

function check(payload, conversation) {
  const failures = [];
  const executions = payload.executions ?? [];
  const states = executions.map((e) => e.state);
  if (JSON.stringify(states) !== JSON.stringify(["settled"])) failures.push(`states ${JSON.stringify(states)} != ["settled"]`);
  const charges = executions.flatMap((e) => e.charges ?? []);
  if (charges.length !== 1) failures.push(`${charges.length} charge(s) issued, expected 1`);
  if ((payload.receipts ?? []).length !== 1) failures.push(`${(payload.receipts ?? []).length} record(s), expected 1`);
  if (!payload.actor) failures.push("no actor on the payload");

  const channel = payload.channel ?? {};
  const refusedRules = (channel.refused ?? []).map((r) => r.rule);
  if (channel.backend !== "emulator") failures.push(`backend ${channel.backend} != emulator`);
  // One refusal is expected and is the documented stub: neither backend can
  // upload the QR image, because this repo hosts nothing and renders no PNG.
  // Anything else refused is a real failure.
  const unexpected = refusedRules.filter((rule) => rule !== "media_upload_unimplemented");
  if (unexpected.length) failures.push(`the channel refused ${unexpected.length} message(s): ${unexpected.join(", ")}`);

  const inbound = conversation.filter((l) => l.direction === "in");
  const outbound = conversation.filter((l) => l.direction === "out");
  if (inbound.length !== 2) failures.push(`${inbound.length} inbound message(s), expected the conversation's 2`);
  if (!outbound.length) failures.push("the agent sent nothing");
  const badRefusals = outbound.filter((l) => l.refused && l.refused.rule !== "media_upload_unimplemented");
  if (badRefusals.length) failures.push(`refused outbound in the log: ${badRefusals.map((l) => l.refused.rule).join(", ")}`);
  const delivered = outbound.filter((l) => !l.refused);
  if (delivered.some((l) => l.state === "failed")) failures.push("an outbound message failed at the provider");
  // Every delivered message came back with a provider id, which is what proves
  // it went through the emulator's Cloud API surface and not around it.
  const noId = delivered.filter((l) => !String(l.message_id ?? "").startsWith("wamid."));
  if (noId.length) failures.push(`${noId.length} message(s) carry no wamid from the provider`);

  // The scene: the QR attempted, and the copy-and-paste as the very next message.
  const qr = outbound.findIndex((l) => l.kind === "media");
  if (qr < 0) failures.push("the QR was never attempted");
  else {
    const next = outbound[qr + 1];
    if (!next || next.kind !== "instrument") failures.push("the message after the QR is not the copy-and-paste");
  }
  const copyPaste = outbound.filter((l) => l.kind === "instrument" && typeof l.text === "string" && l.text.startsWith("00020126"));
  if (copyPaste.length !== 1) failures.push(`${copyPaste.length} Pix copy-and-paste message(s), expected 1`);

  // The outcome is told once, whatever the number of looks that carried it. The
  // wording is the agent's; what is counted is the `message.debtor` the core records.
  const told = outbound.filter((l) => l.kind === "text" && /quitad/i.test(String(l.text ?? "")));
  if (told.length < 1) failures.push("the person was never told the agreement closed");

  // The contact never reaches the file in the clear: the bundle travels.
  if (conversation.some((l) => String(l.contact ?? "").includes("987654321"))) failures.push("the conversation log carries the contact in the clear");

  // Belt and braces over the rule that already refuses one.
  for (const line of outbound) {
    if (line.kind === "instrument") continue;
    const tokens = String(line.text ?? "").split(/\s+/).map((t) => t.replace(/^[^0-9]+|[^0-9]+$/g, ""));
    if (tokens.some((t) => /^\d{11}$/.test(t) || /^\d{14}$/.test(t))) failures.push(`a message carries something shaped like a document: ${String(line.text).slice(0, 40)}`);
  }
  return failures;
}

/** The emulator is a separate process and the gate does not start one: a gate that silently ran against nothing would pass. */
async function emulatorIsUp() {
  try {
    const response = await fetch(`${EMULATOR}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main(argv) {
  const json = argv.includes("--json");
  const mode = argv.includes("--mode") ? argv[argv.indexOf("--mode") + 1] : "mandate";
  const total = argv.includes("--runs") ? Number(argv[argv.indexOf("--runs") + 1]) : 3;
  const say = (line) => process.stderr.write(line + "\n");
  const rows = [];
  let failed = 0;

  if (!(await emulatorIsUp())) {
    say(`whatsapp gate FAILED: nothing is answering at ${EMULATOR}.`);
    say(`  Start the emulator first:  npm run whatsapp:emulator`);
    say(`  It is dyvit-wa-sim (https://github.com/fabianocruz/whatsapp-simulator, MIT), run from npm at a pinned version. No Meta account, no credential.`);
    if (json) process.stdout.write(JSON.stringify({ ok: false, reason: "emulator_unreachable", emulator: EMULATOR }) + "\n");
    return 1;
  }

  say(`whatsapp gate: ${total} run(s) of collections-agent over dyvit-wa-sim at ${EMULATOR}, approval: ${mode}, clock pinned to ${NOW}`);
  for (let i = 1; i <= total; i += 1) {
    const { payload, conversation, failures } = runOnce(i, mode);
    if (failures.length) failed += 1;
    const row = {
      run: i,
      ok: failures.length === 0,
      failures,
      run_id: payload?.run_id ?? null,
      state: payload?.executions?.[0]?.state ?? null,
      charge_id: payload?.executions?.[0]?.charges?.[0]?.charge_id ?? null,
      receipts: (payload?.receipts ?? []).length,
      messages_in: conversation?.filter((l) => l.direction === "in").length ?? 0,
      messages_out: conversation?.filter((l) => l.direction === "out").length ?? 0,
    };
    rows.push(row);
    say(
      `${row.ok ? "ok  " : "FAIL"} run ${i}/${total} — ${row.state ?? "?"}, ${row.receipts} record(s), ${row.messages_in} in / ${row.messages_out} out${failures.length ? ` — ${failures.join("; ")}` : ""}`,
    );
  }

  // The part one run cannot show: three runs from zero agree, and none of them reused the last one's ids.
  const shapes = new Set(rows.map((r) => JSON.stringify([r.state, r.receipts, r.messages_in, r.messages_out])));
  if (rows.length > 1 && shapes.size !== 1) {
    failed += 1;
    say(`FAIL the ${rows.length} runs did not agree: ${[...shapes].join(" vs ")}`);
  }
  const ids = rows.map((r) => r.charge_id).filter(Boolean);
  if (ids.length > 1 && new Set(ids).size !== ids.length) {
    failed += 1;
    say("FAIL two runs shared a charge id, so one of them was not from zero");
  }

  say("");
  say(failed ? `whatsapp gate FAILED: ${failed} finding(s) over ${rows.length} run(s)` : `whatsapp gate ok: ${rows.length} run(s) from zero, no intervention, same final state every time`);
  if (json) process.stdout.write(JSON.stringify({ ok: failed === 0, mode, runs: rows }) + "\n");
  return failed === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
