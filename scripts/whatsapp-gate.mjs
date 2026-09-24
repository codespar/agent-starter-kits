#!/usr/bin/env node
/**
 * Wave 4's gate: "três execuções do zero sem intervenção", plus the fourth
 * run that made issue #25 necessary.
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
 * THE FOURTH RUN is a different shape and is the production case the other
 * three cannot reach: the debtor agrees on Tuesday and pays on Friday. It
 * runs in two processes with the CONVERSATION's clock moved between them —
 * agree and issue, `POST /_sim/clock {"advance_hours": 26}`, then
 * `codespar-agent poll --channel whatsapp`, which finds the charge paid by
 * the sandbox payer and confirms it. What it asserts is that the confirmation
 * went out as a TEMPLATE and the execution reached its terminal state.
 *
 * Read that assertion precisely. The emulator PRICES the 24-hour window and
 * does not ENFORCE it (gap **a** of docs/OPEN_QUESTIONS.md §46): a free-form
 * send after the clock moves answers 200 here where Meta answers 400/131047.
 * So what passes here is OUR choice of carrier, made by the session window in
 * `channels/whatsapp/session.ts` — not the provider refusing the alternative.
 * The day the emulator enforces the window this run gets stronger without
 * changing.
 *
 * Two clocks, and they are not the same thing (#16). `--now` pins the AGENT's
 * notion of now, which the guardrails and the window comparison read;
 * `POST /_sim/clock` moves the CONVERSATION's, which is where the person's
 * last message sits. The fourth run needs both and moves them together.
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
/** The one conversation this gate drives, in every run. */
const CONVERSATION = "acordo-1042";
/** `start --channel whatsapp` against it, with nobody at a keyboard. */
const START = ["start", "--agent", AGENT, "--channel", "whatsapp", "--conversation", CONVERSATION, "--scripted"];
/** Pinned so the collection-hours guardrail reads the same at 03:00 as at 15:00 (#16). */
const NOW = "2026-09-23T14:00:00-03:00";
/** How far past the 24 hours the fourth run moves the conversation. Two hours of margin, and still inside the collection window. */
const WINDOW_ADVANCE_HOURS = 26;
/** The agent's clock for the poll, moved by the same amount as the conversation's. 16:00 in Sao Paulo, inside 08:00-20:00. */
const NOW_AFTER_WINDOW = new Date(new Date(NOW).getTime() + WINDOW_ADVANCE_HOURS * 3600_000).toISOString();
/**
 * The fourth run replays a DIFFERENT recording, and the reason is not
 * cosmetic. The shipped `happy-path` transcript was recorded where the payer
 * paid inside the turn, so its closing line tells Joana the agreement is
 * settled. Here it is not settled yet — that is the whole point — and a
 * conversation that says "quitado" before the money arrives is a lie whoever
 * recorded it. This one says the charge is issued and the confirmation will
 * follow, which is what the poll then sends.
 */
const AGREED_TRANSCRIPT = join(AGENT, "test/fixtures/agreed-1042-awaiting-payer.transcript.jsonl");

/** One `codespar-agent` process against the agent under test, with neither key set. */
function agent(args, env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    // Neither key: the replay provider and the stub rail are the whole world, and the simulator needs no Meta account.
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", ...env },
    encoding: "utf8",
    timeout: 180_000,
  });
}

/** The last JSON line a run put on stdout, or what went wrong instead. */
function payloadOf(result) {
  if (result.error) return { failure: String(result.error.message ?? result.error) };
  const line = (result.stdout ?? "").split("\n").filter(Boolean).pop();
  if (!line) return { failure: `no JSON on stdout (exit ${result.status})\n${(result.stderr ?? "").trim()}` };
  try {
    return { payload: JSON.parse(line) };
  } catch {
    return { failure: `stdout was not JSON (exit ${result.status}): ${line.slice(0, 200)}` };
  }
}

/** The conversation as the bundle recorded it. */
function conversationOf(logPath) {
  const path = isAbsolute(logPath ?? "") ? logPath : join(ROOT, logPath ?? "");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function runOnce(index, mode) {
  const state = mkdtempSync(join(tmpdir(), `wa-gate-state-${index}-`));
  const runs = mkdtempSync(join(tmpdir(), `wa-gate-runs-${index}-`));
  try {
    const result = agent(
      [
        ...START,
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
      { COLLECTIONS_STATE_DIR: state, COLLECTIONS_RUNS_DIR: runs },
    );
    const { payload, failure } = payloadOf(result);
    if (failure) return { failures: [failure] };
    const conversation = conversationOf(payload.channel?.log);
    return { payload, conversation, failures: check(payload, conversation) };
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
}

/**
 * The fourth run: agreed on Tuesday, paid on Friday.
 *
 * Two processes over ONE state directory, because that is the shape in
 * production — the run that agreed the terms is long gone by the time the
 * money lands, and what carries the cycle across is the record it left. The
 * conversation's clock moves between them; the agent's moves with it.
 */
async function runWindowCase(mode) {
  const state = mkdtempSync(join(tmpdir(), "wa-gate-state-window-"));
  const runs = mkdtempSync(join(tmpdir(), "wa-gate-runs-window-"));
  const env = { COLLECTIONS_STATE_DIR: state, COLLECTIONS_RUNS_DIR: runs };
  try {
    // Tuesday: the debtor agrees, the bolepix is issued, and NOBODY pays. The
    // fixture payer is told to sit on it, which is what makes this run end
    // with the execution still open instead of settling inside the turn.
    const agreed = agent(
      [...START, "--mode", mode, ...(mode === "human" ? ["--approve"] : []), "--transcript", AGREED_TRANSCRIPT, "--now", NOW, "--json"],
      { ...env, COLLECTIONS_STUB_PAYER: "never" },
    );
    const first = payloadOf(agreed);
    if (first.failure) return { failures: [`agree: ${first.failure}`] };
    const failures = [];
    const open = first.payload.executions?.[0];
    if (open?.state !== "executing") failures.push(`after agreeing the execution is ${open?.state}, expected executing (nobody has paid yet)`);
    if ((first.payload.receipts ?? []).length !== 0) failures.push("a record was written for a charge nobody paid");
    const agreedLog = conversationOf(first.payload.channel?.log);
    if (agreedLog.some((l) => l.direction === "out" && /quitad/i.test(String(l.text ?? "")))) {
      failures.push("the debtor was told the agreement was settled before anybody paid");
    }

    // Friday. The CONVERSATION's clock is the emulator's and moves here; the
    // agent's own is `--now` on the poll below, and the two are different
    // things (#16).
    const moved = await fetch(`${EMULATOR}/_sim/clock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ advance_hours: WINDOW_ADVANCE_HOURS }),
      signal: AbortSignal.timeout(5000),
    }).catch((err) => ({ ok: false, detail: String(err) }));
    if (!moved.ok) return { failures: [...failures, `could not move the emulator clock: ${moved.detail ?? moved.status}`] };

    // The payer pays, the poll finds it, and the confirmation goes out over a
    // window that has been shut for two hours.
    const polled = agent(
      ["poll", "--agent", AGENT, "--channel", "whatsapp", "--conversation", CONVERSATION, "--simulate-payer", "--now", NOW_AFTER_WINDOW, "--json"],
      env,
    );
    const second = payloadOf(polled);
    if (second.failure) return { failures: [...failures, `poll: ${second.failure}`] };
    const payload = second.payload;
    const conversation = conversationOf(payload.channel?.log);
    return { payload, conversation, exit: polled.status, failures: [...failures, ...checkWindow(payload, conversation, polled.status)] };
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
}

/**
 * What the fourth run has to show. The execution reached its terminal state,
 * and the message that says so went out as a TEMPLATE — which is OUR choice,
 * made because the window is shut, and not the provider refusing the
 * alternative (§46a: the emulator prices the window and does not enforce it).
 */
function checkWindow(payload, conversation, exit) {
  const failures = [];
  if (exit !== 0) failures.push(`poll exited ${exit}, expected 0`);
  const polled = payload.polled ?? [];
  if (polled.length !== 1) failures.push(`the poll closed ${polled.length} execution(s), expected 1`);
  const one = polled[0] ?? {};
  if (one.state !== "settled") failures.push(`the execution ended ${one.state}, expected settled`);
  if (one.timed_out) failures.push("the poll timed out instead of closing the cycle");
  if (one.session_open !== false) failures.push("the 24-hour window was still open: the run did not reach the case it exists for");
  if (one.delivery?.told !== true) failures.push(`the debtor was not told: ${JSON.stringify(one.delivery)}`);
  if (one.delivery?.carrier !== "template") failures.push(`the confirmation went out as ${one.delivery?.carrier}, expected a template`);

  // The conversation is ONE record: the poll appended to the bundle of the
  // run that opened it, so the confirmation sits under the QR it confirms.
  const outbound = conversation.filter((l) => l.direction === "out");
  const templates = outbound.filter((l) => l.kind === "template");
  if (templates.length !== 1) failures.push(`${templates.length} template(s) in the conversation, expected 1`);
  const last = outbound[outbound.length - 1];
  if (!last || last.kind !== "template") failures.push(`the last message of the conversation is a ${last?.kind}, expected the template that closes it`);
  if (last?.refused) failures.push(`the confirmation was refused: ${last.refused.rule}`);
  if (!String(last?.message_id ?? "").startsWith("wamid.")) failures.push("the confirmation carries no wamid: it did not go through the provider's surface");
  if (!/acordo_quitado/.test(String(last?.text ?? ""))) failures.push(`the template sent was ${last?.text}, expected acordo_quitado`);
  // `payload.channel` is the POLL's own view — the lines this second process
  // put on the channel, not the whole file — so it is where "nothing else
  // went out once the window had shut" is actually decidable.
  if ((payload.channel?.messages_out ?? 0) !== 1) failures.push(`the poll sent ${payload.channel?.messages_out} message(s) with the window shut, expected 1`);
  if ((payload.channel?.refused ?? []).length) failures.push(`the poll had ${payload.channel.refused.length} message(s) refused: ${payload.channel.refused.map((r) => r.rule).join(", ")}`);
  if (payload.channel?.session_open !== false) failures.push("the poll reports the window open");
  failures.push(...discretionFailures(conversation));
  return failures;
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

  failures.push(...discretionFailures(conversation));
  return failures;
}

/**
 * The two rules every run of this gate is held to, whatever its shape: the
 * bundle travels, so the contact never reaches it in the clear, and no
 * message carries a document. Belt and braces over rules the channel already
 * enforces — a gate that only checks what the code checks proves nothing.
 */
function discretionFailures(conversation) {
  const failures = [];
  if (conversation.some((l) => String(l.contact ?? "").includes("987654321"))) failures.push("the conversation log carries the contact in the clear");
  for (const line of conversation.filter((l) => l.direction === "out")) {
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

  // The fourth run, and the one the other three cannot reach: the debtor
  // agrees, the clock moves past the 24 hours, the payer pays, and the poll
  // confirms it with the only thing WhatsApp carries by then.
  say("");
  say(`whatsapp gate, janela: acordo agora, pagamento ${WINDOW_ADVANCE_HOURS}h depois — dois processos, o relogio da conversa andando entre eles`);
  const window = await runWindowCase(mode);
  if (window.failures.length) failed += 1;
  const windowRow = {
    run: "window",
    ok: window.failures.length === 0,
    failures: window.failures,
    state: window.payload?.polled?.[0]?.state ?? null,
    session_open: window.payload?.polled?.[0]?.session_open ?? null,
    carrier: window.payload?.polled?.[0]?.delivery?.carrier ?? null,
    template: window.payload?.polled?.[0]?.delivery?.template ?? null,
    messages_out: window.conversation?.filter((l) => l.direction === "out").length ?? 0,
  };
  say(
    `${windowRow.ok ? "ok  " : "FAIL"} run janela — ${windowRow.state ?? "?"}, janela ${windowRow.session_open === false ? "fechada" : "aberta"}, avisado por ${windowRow.carrier ?? "?"} ${windowRow.template ?? ""}${
      window.failures.length ? ` — ${window.failures.join("; ")}` : ""
    }`,
  );
  if (windowRow.ok) {
    say("      (o que passou aqui e a NOSSA escolha de template: o emulador precifica a janela e nao a aplica — docs/OPEN_QUESTIONS.md §46a)");
  }

  say("");
  say(failed ? `whatsapp gate FAILED: ${failed} finding(s) over ${rows.length + 1} run(s)` : `whatsapp gate ok: ${rows.length} run(s) from zero plus the window run, no intervention, same final state every time`);
  if (json) process.stdout.write(JSON.stringify({ ok: failed === 0, mode, runs: rows, window: windowRow }) + "\n");
  return failed === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
