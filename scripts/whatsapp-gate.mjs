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
 * Since 0.2.0 the emulator ENFORCES the window the way Meta does (§46a,
 * closed): a free-form send after the clock moves answers 400/131047. So the
 * run also asks the PROVIDER, right after the clock moves, whether it would
 * have carried the alternative — and fails if it would. The template is then
 * both our choice, made by the session window in
 * `channels/whatsapp/session.ts`, and the only thing the provider takes.
 *
 * THE FIFTH RUN is the same two processes with the clocks deliberately apart:
 * the conversation's moves 26 hours and the agent's only one, so our window
 * reads OPEN and the provider's is shut. That is the boundary race in
 * production — our check at 23:59:59, Meta's at 24:00:01 — and it is only
 * drivable because the emulator now refuses. What it asserts: the free-form
 * confirmation went to the provider, came back 131047, and the poll told the
 * person anyway, by the template, exactly once.
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
/** The fifth run's agent clock: one hour on, while the conversation's is 26. Our window reads open, the provider's is shut. */
const NOW_CLOCKS_APART = new Date(new Date(NOW).getTime() + 3600_000).toISOString();
/** Who the conversation is with, and from which number, as the channel sends it: the provider probe has to name the same conversation. */
const CONTACT = JSON.parse(readFileSync(join(AGENT, `channels/whatsapp/${CONVERSATION}.json`), "utf8")).contact;
/**
 * A conversation of its own for every run (#42). The emulator keys a
 * conversation on `phone_number_id:contact` and keeps every inbound message
 * it ever received under that key, dated by whatever clock was pinned when it
 * arrived. The 24-hour window it enforces is counted from the LATEST of them —
 * so a run that pinned its clock to 22:30 leaves an inbound "from the future"
 * for a run that pins 14:00 next, and that run finds the window open. The
 * contact is the agent's and stays what the channel's rules bind; the phone
 * number id is the emulator's, and a fresh one per run is a fresh conversation.
 * The same move the runtime's own integration test makes per case.
 */
const freshPhoneNumberId = () => `9${String(Math.floor(Math.random() * 1e11)).padStart(11, "0")}`;
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
      { COLLECTIONS_STATE_DIR: state, COLLECTIONS_RUNS_DIR: runs, WHATSAPP_SIM_PHONE_NUMBER_ID: freshPhoneNumberId() },
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
async function runWindowCase(mode, { agentNow = NOW_AFTER_WINDOW, check = checkWindow, probe = true } = {}) {
  const state = mkdtempSync(join(tmpdir(), "wa-gate-state-window-"));
  const runs = mkdtempSync(join(tmpdir(), "wa-gate-runs-window-"));
  // One conversation for both processes of the case, and for the probe: the case IS that conversation.
  const phoneNumberId = freshPhoneNumberId();
  const env = { COLLECTIONS_STATE_DIR: state, COLLECTIONS_RUNS_DIR: runs, WHATSAPP_SIM_PHONE_NUMBER_ID: phoneNumberId };
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

    // Ask the provider, not ourselves, whether the window is shut: the
    // free-form alternative must be refused with Meta's 131047. A 200 here
    // means the template below is only our preference.
    if (probe) failures.push(...(await providerRefusesFreeForm(CONTACT, phoneNumberId)));

    // The payer pays, the poll finds it, and the confirmation goes out over a
    // window that has been shut for two hours.
    const polled = agent(
      ["poll", "--agent", AGENT, "--channel", "whatsapp", "--conversation", CONVERSATION, "--simulate-payer", "--now", agentNow, "--json"],
      env,
    );
    const second = payloadOf(polled);
    if (second.failure) return { failures: [...failures, `poll: ${second.failure}`] };
    const payload = second.payload;
    const conversation = conversationOf(payload.channel?.log);
    return { payload, conversation, exit: polled.status, failures: [...failures, ...check(payload, conversation, polled.status)] };
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
}

/**
 * The provider's own answer to a free-form message in this conversation, sent
 * straight to its Graph surface. On 0.2.0 it is 400/131047 and nothing is
 * recorded, so the probe leaves the conversation as it found it.
 */
async function providerRefusesFreeForm(contact, phoneNumberId) {
  const response = await fetch(`${EMULATOR}/v22.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: contact.replace(/^\+/, ""), type: "text", text: { preview_url: false, body: "sonda da janela" } }),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => ({ status: 0, json: async () => ({ detail: String(err) }) }));
  const body = await response.json().catch(() => ({}));
  if (response.status === 400 && body?.error?.code === 131047) return [];
  return [`the provider answered ${response.status}${body?.error?.code ? `/${body.error.code}` : ""} to a free-form message across the shut window, expected 400/131047: the template is only our choice`];
}

/**
 * What the fourth run has to show. The execution reached its terminal state,
 * and the message that says so went out as a TEMPLATE — our choice, made
 * because the window is shut, and (probed above) the only carrier the
 * provider would have taken.
 */
function checkWindow(payload, conversation, exit, { template = "acordo_quitado", contact = CONTACT } = {}) {
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
  if (!String(last?.text ?? "").includes(template)) failures.push(`the template sent was ${last?.text}, expected ${template}`);
  // `payload.channel` is the POLL's own view — the lines this second process
  // put on the channel, not the whole file — so it is where "nothing else
  // went out once the window had shut" is actually decidable.
  if ((payload.channel?.messages_out ?? 0) !== 1) failures.push(`the poll sent ${payload.channel?.messages_out} message(s) with the window shut, expected 1`);
  if ((payload.channel?.refused ?? []).length) failures.push(`the poll had ${payload.channel.refused.length} message(s) refused: ${payload.channel.refused.map((r) => r.rule).join(", ")}`);
  if (payload.channel?.session_open !== false) failures.push("the poll reports the window open");
  failures.push(...discretionFailures(conversation, contact));
  return failures;
}

/**
 * What the fifth run has to show: the clocks disagreed, the provider won. The
 * poll believed the window open and tried the free-form message, the provider
 * refused it with 131047, and the person was told anyway — by the template,
 * once, in the same conversation. Anything else is either a confirmation lost
 * (the cursor was taken and nothing arrived) or a second one sent.
 */
function checkClocksApart(payload, conversation, exit) {
  const failures = [];
  if (exit !== 0) failures.push(`poll exited ${exit}, expected 0`);
  const one = (payload.polled ?? [])[0] ?? {};
  if (one.state !== "settled") failures.push(`the execution ended ${one.state}, expected settled`);
  if (one.session_open !== true) failures.push("the agent's window read shut: the clocks were not apart, so the run did not reach the case it exists for");
  if (one.delivery?.told !== true) failures.push(`the debtor was not told: ${JSON.stringify(one.delivery)}`);
  if (one.delivery?.carrier !== "template") failures.push(`the confirmation went out as ${one.delivery?.carrier}, expected the template after the provider's 131047`);
  const refused = payload.channel?.refused ?? [];
  if (refused.length !== 1 || refused[0].rule !== "session_window_closed" || !/131047/.test(refused[0].detail)) {
    failures.push(`expected exactly one refusal, the provider's 131047; got ${JSON.stringify(refused)}`);
  }
  if ((payload.channel?.messages_out ?? 0) !== 1) failures.push(`the poll delivered ${payload.channel?.messages_out} message(s), expected the one template`);
  if (payload.channel?.session_open !== false) failures.push("after the provider's 131047 the channel still reports the window open");
  const outbound = conversation.filter((l) => l.direction === "out");
  const last = outbound[outbound.length - 1];
  if (!last || last.kind !== "template" || last.refused) failures.push(`the conversation does not end with the delivered template: ${last?.kind}${last?.refused ? ` (${last.refused.rule})` : ""}`);
  if (!String(last?.message_id ?? "").startsWith("wamid.")) failures.push("the template carries no wamid: it did not go through the provider's surface");
  const beforeLast = outbound[outbound.length - 2];
  if (beforeLast?.kind !== "text" || beforeLast?.refused?.rule !== "session_window_closed") failures.push("the refused free-form attempt is not recorded just before the template");
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
function discretionFailures(conversation, contact = CONTACT) {
  const failures = [];
  const digits = contact.replace(/^\+55\d{2}/, "");
  if (conversation.some((l) => String(l.contact ?? "").includes(digits))) failures.push("the conversation log carries the contact in the clear");
  for (const line of conversation.filter((l) => l.direction === "out")) {
    if (line.kind === "instrument") continue;
    const tokens = String(line.text ?? "").split(/\s+/).map((t) => t.replace(/^[^0-9]+|[^0-9]+$/g, ""));
    if (tokens.some((t) => /^\d{11}$/.test(t) || /^\d{14}$/.test(t))) failures.push(`a message carries something shaped like a document: ${String(line.text).slice(0, 40)}`);
  }
  return failures;
}

/**
 * The checkout-agent over the same channel (checkout decision 6): the sale
 * the terminal runbook shows, from a clean state three times, and the
 * ordered-tonight-paid-tomorrow case across a shut window. The customer's
 * turns come from `pedido-marina`, the model from the recorded happy path,
 * the rail and the issuer are stubs. What passes is the final state and the
 * shape of the conversation, as above: the order settled, one charge, one
 * paid record, the NFS-e that follows it accepted, the QR followed by the
 * copy-and-paste, "pedido confirmado" said, no document in any message.
 */
const CHECKOUT = join(ROOT, "agents/checkout-agent");
const CHECKOUT_CONVERSATION = "pedido-marina";
const CHECKOUT_START = ["start", "--agent", CHECKOUT, "--channel", "whatsapp", "--conversation", CHECKOUT_CONVERSATION, "--scripted"];
const CHECKOUT_CONTACT = JSON.parse(readFileSync(join(CHECKOUT, `channels/whatsapp/${CHECKOUT_CONVERSATION}.json`), "utf8")).contact;
/** Issued tonight and not yet paid: the recording that ends with the charge out, not with "pedido confirmado". */
const ORDERED_TRANSCRIPT = join(CHECKOUT, "test/fixtures/ordered-marina-awaiting-payer.transcript.jsonl");

function runCheckoutOnce(index, mode) {
  const state = mkdtempSync(join(tmpdir(), `wa-gate-checkout-state-${index}-`));
  const runs = mkdtempSync(join(tmpdir(), `wa-gate-checkout-runs-${index}-`));
  try {
    const result = agent([...CHECKOUT_START, "--mode", mode, ...(mode === "human" ? ["--approve"] : []), "--simulate-payer", "--now", NOW, "--json"], { CHECKOUT_STATE_DIR: state, CHECKOUT_RUNS_DIR: runs, WHATSAPP_SIM_PHONE_NUMBER_ID: freshPhoneNumberId() });
    const { payload, failure } = payloadOf(result);
    if (failure) return { failures: [failure] };
    const conversation = conversationOf(payload.channel?.log);
    return { payload, conversation, failures: checkCheckout(payload, conversation) };
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
}

function checkCheckout(payload, conversation) {
  const failures = [];
  const executions = payload.executions ?? [];
  if (JSON.stringify(executions.map((e) => e.state)) !== JSON.stringify(["settled"])) failures.push(`states ${JSON.stringify(executions.map((e) => e.state))} != ["settled"]`);
  if (!executions[0]?.charge_id) failures.push("no charge id on the order");
  if (!/^sha256:/.test(String(executions[0]?.cart_hash ?? ""))) failures.push("the order carries no cart_hash");
  if ((payload.receipts ?? []).length !== 1) failures.push(`${(payload.receipts ?? []).length} paid record(s), expected 1`);
  const invoices = payload.invoices ?? [];
  if (invoices.length !== 1 || invoices[0].state !== "accepted") failures.push(`the NFS-e that follows the sale is ${JSON.stringify(invoices.map((i) => i.state))}, expected ["accepted"]`);
  if (!payload.actor) failures.push("no actor on the payload");
  const channel = payload.channel ?? {};
  if (channel.backend !== "emulator") failures.push(`backend ${channel.backend} != emulator`);
  const unexpected = (channel.refused ?? []).map((r) => r.rule).filter((rule) => rule !== "media_upload_unimplemented");
  if (unexpected.length) failures.push(`the channel refused ${unexpected.length} message(s): ${unexpected.join(", ")}`);
  const inbound = conversation.filter((l) => l.direction === "in");
  const outbound = conversation.filter((l) => l.direction === "out");
  if (inbound.length !== 2) failures.push(`${inbound.length} inbound message(s), expected the conversation's 2`);
  const delivered = outbound.filter((l) => !l.refused);
  const noId = delivered.filter((l) => !String(l.message_id ?? "").startsWith("wamid."));
  if (noId.length) failures.push(`${noId.length} message(s) carry no wamid from the provider`);
  const qr = outbound.findIndex((l) => l.kind === "media");
  if (qr < 0) failures.push("the QR was never attempted");
  else if (outbound[qr + 1]?.kind !== "instrument") failures.push("the message after the QR is not the copy-and-paste");
  const copyPaste = outbound.filter((l) => l.kind === "instrument" && String(l.text ?? "").startsWith("00020126"));
  if (copyPaste.length !== 1) failures.push(`${copyPaste.length} Pix copy-and-paste message(s), expected 1`);
  if (!outbound.some((l) => l.kind === "text" && /pedido confirmado/i.test(String(l.text ?? "")))) failures.push("the customer was never told the order was confirmed");
  if (outbound.some((l) => /nota fiscal|nfs-e/i.test(String(l.text ?? "")))) failures.push("the customer was told about the invoice, which is the attendant's");
  failures.push(...discretionFailures(conversation, CHECKOUT_CONTACT));
  return failures;
}

/** Ordered tonight, paid tomorrow: two processes over one state, the conversation's clock moved 26 hours between them. */
async function runCheckoutWindow(mode) {
  const state = mkdtempSync(join(tmpdir(), "wa-gate-checkout-window-"));
  const runs = mkdtempSync(join(tmpdir(), "wa-gate-checkout-window-runs-"));
  const phoneNumberId = freshPhoneNumberId();
  const env = { CHECKOUT_STATE_DIR: state, CHECKOUT_RUNS_DIR: runs, WHATSAPP_SIM_PHONE_NUMBER_ID: phoneNumberId };
  try {
    const ordered = agent([...CHECKOUT_START, "--mode", mode, ...(mode === "human" ? ["--approve"] : []), "--transcript", ORDERED_TRANSCRIPT, "--now", NOW, "--json"], { ...env, CHECKOUT_STUB_PAYER: "never" });
    const first = payloadOf(ordered);
    if (first.failure) return { failures: [`order: ${first.failure}`] };
    const failures = [];
    if (first.payload.executions?.[0]?.state !== "executing") failures.push(`after ordering the execution is ${first.payload.executions?.[0]?.state}, expected executing (nobody has paid yet)`);
    if (conversationOf(first.payload.channel?.log).some((l) => l.direction === "out" && /pedido confirmado/i.test(String(l.text ?? "")))) failures.push("the customer was told the order was confirmed before anybody paid");
    const moved = await fetch(`${EMULATOR}/_sim/clock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ advance_hours: WINDOW_ADVANCE_HOURS }), signal: AbortSignal.timeout(5000) }).catch((err) => ({ ok: false, detail: String(err) }));
    if (!moved.ok) return { failures: [...failures, `could not move the emulator clock: ${moved.detail ?? moved.status}`] };
    failures.push(...(await providerRefusesFreeForm(CHECKOUT_CONTACT, phoneNumberId)));
    const polled = agent(["poll", "--agent", CHECKOUT, "--channel", "whatsapp", "--conversation", CHECKOUT_CONVERSATION, "--simulate-payer", "--now", NOW_AFTER_WINDOW, "--json"], env);
    const second = payloadOf(polled);
    if (second.failure) return { failures: [...failures, `poll: ${second.failure}`] };
    const conversation = conversationOf(second.payload.channel?.log);
    return { payload: second.payload, conversation, failures: [...failures, ...checkWindow(second.payload, conversation, polled.status, { template: "pedido_confirmado", contact: CHECKOUT_CONTACT })] };
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
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
    say("      (e o provedor recusou a alternativa: mensagem livre com a janela fechada volta 400/131047 — docs/OPEN_QUESTIONS.md §46a)");
  }

  // The fifth run: the same case with the clocks apart, so our window reads
  // open and the provider's is shut, and only the provider's 131047 tells.
  say("");
  say(`whatsapp gate, relogios divergentes: a conversa andou ${WINDOW_ADVANCE_HOURS}h, o agente 1h — a nossa janela le aberta, a do provedor esta fechada`);
  const apart = await runWindowCase(mode, { agentNow: NOW_CLOCKS_APART, check: checkClocksApart, probe: false });
  if (apart.failures.length) failed += 1;
  const apartRow = {
    run: "clocks_apart",
    ok: apart.failures.length === 0,
    failures: apart.failures,
    state: apart.payload?.polled?.[0]?.state ?? null,
    refused: (apart.payload?.channel?.refused ?? []).map((r) => r.rule),
    carrier: apart.payload?.polled?.[0]?.delivery?.carrier ?? null,
    template: apart.payload?.polled?.[0]?.delivery?.template ?? null,
  };
  say(
    `${apartRow.ok ? "ok  " : "FAIL"} run relogios — ${apartRow.state ?? "?"}, recusada pelo provedor: ${apartRow.refused.join(", ") || "nada"}, avisado por ${apartRow.carrier ?? "?"} ${apartRow.template ?? ""}${
      apart.failures.length ? ` — ${apart.failures.join("; ")}` : ""
    }`,
  );

  // The checkout-agent: the same channel, a sale instead of a debt.
  say("");
  say(`whatsapp gate: ${total} run(s) of checkout-agent over dyvit-wa-sim, conversation ${CHECKOUT_CONVERSATION}, approval: ${mode}`);
  const checkoutRows = [];
  for (let i = 1; i <= total; i += 1) {
    const { payload, conversation, failures } = runCheckoutOnce(i, mode);
    if (failures.length) failed += 1;
    const row = { run: i, ok: failures.length === 0, failures, state: payload?.executions?.[0]?.state ?? null, charge_id: payload?.executions?.[0]?.charge_id ?? null, invoice: payload?.invoices?.[0]?.state ?? null, receipts: (payload?.receipts ?? []).length, messages_in: conversation?.filter((l) => l.direction === "in").length ?? 0, messages_out: conversation?.filter((l) => l.direction === "out").length ?? 0 };
    checkoutRows.push(row);
    say(`${row.ok ? "ok  " : "FAIL"} run ${i}/${total} — ${row.state ?? "?"}, NFS-e ${row.invoice ?? "?"}, ${row.receipts} record(s), ${row.messages_in} in / ${row.messages_out} out${failures.length ? ` — ${failures.join("; ")}` : ""}`);
  }
  const checkoutShapes = new Set(checkoutRows.map((r) => JSON.stringify([r.state, r.invoice, r.receipts, r.messages_in, r.messages_out])));
  if (checkoutRows.length > 1 && checkoutShapes.size !== 1) {
    failed += 1;
    say(`FAIL the ${checkoutRows.length} checkout runs did not agree: ${[...checkoutShapes].join(" vs ")}`);
  }
  const checkoutIds = checkoutRows.map((r) => r.charge_id).filter(Boolean);
  if (checkoutIds.length > 1 && new Set(checkoutIds).size !== checkoutIds.length) {
    failed += 1;
    say("FAIL two checkout runs shared a charge id, so one of them was not from zero");
  }
  say("");
  say(`whatsapp gate, checkout janela: pedido agora, pagamento ${WINDOW_ADVANCE_HOURS}h depois`);
  const checkoutWindow = await runCheckoutWindow(mode);
  if (checkoutWindow.failures.length) failed += 1;
  const checkoutWindowRow = { run: "window", ok: checkoutWindow.failures.length === 0, failures: checkoutWindow.failures, state: checkoutWindow.payload?.polled?.[0]?.state ?? null, carrier: checkoutWindow.payload?.polled?.[0]?.delivery?.carrier ?? null, template: checkoutWindow.payload?.polled?.[0]?.delivery?.template ?? null };
  say(`${checkoutWindowRow.ok ? "ok  " : "FAIL"} run janela — ${checkoutWindowRow.state ?? "?"}, avisado por ${checkoutWindowRow.carrier ?? "?"} ${checkoutWindowRow.template ?? ""}${checkoutWindow.failures.length ? ` — ${checkoutWindow.failures.join("; ")}` : ""}`);

  say("");
  const allRuns = rows.length + 2 + checkoutRows.length + 1;
  say(failed ? `whatsapp gate FAILED: ${failed} finding(s) over ${allRuns} run(s)` : `whatsapp gate ok: ${rows.length} collections run(s) from zero plus the window run and the clocks-apart run, and ${checkoutRows.length} checkout run(s) from zero plus its window run, no intervention, same final state every time`);
  if (json) process.stdout.write(JSON.stringify({ ok: failed === 0, mode, runs: rows, window: windowRow, clocks_apart: apartRow, checkout: { runs: checkoutRows, window: checkoutWindowRow } }) + "\n");
  return failed === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
