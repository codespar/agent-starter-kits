/**
 * What the emulator does, measured rather than assumed — and what it does NOT
 * do, which is the more useful half.
 *
 * These run against `dyvit-wa-sim` (https://github.com/fabianocruz/whatsapp-simulator,
 * MIT) at the version `scripts/whatsapp-emulator.mjs` pins. They SKIP when it is
 * not listening, so `npm test` is green on a machine that never started it; the
 * CI starts it, and `npm run whatsapp:gate` fails loudly rather than skipping,
 * so nothing important hides behind a skip.
 *
 * Two kinds of assertion live here and they are not the same thing.
 *
 *   What the emulator gets RIGHT, which our adapter depends on: the Cloud API
 *   response shape, the signed webhook, the controllable clock. If one of these
 *   breaks, our channel breaks.
 *
 *   What 0.2.0 closed of the five gaps §46 of `docs/OPEN_QUESTIONS.md` measured
 *   against 0.1.1. These were pinned as GAP tests that asserted the OLD
 *   behaviour; each is now asked of the published binary in the form that
 *   would go red if the gap reopened — the refusal is checked for what it did
 *   NOT do (record, webhook) as well as for what it answered, because a 400
 *   that still recorded the message would be the old gap wearing a new status.
 */
import { describe, expect, it } from "vitest";
import { EMULATOR_DEFAULTS, EmulatorDriver } from "../src/channels/whatsapp/emulator.js";
import { buildSendRequest, WhatsAppCloudApi, type CloudApiConfig } from "../src/channels/whatsapp/cloud-api.js";

const URL_BASE = process.env["WHATSAPP_SIM_URL"] ?? "http://127.0.0.1:4290";

/**
 * Probed at MODULE level, not in a `beforeAll`: `describe.skipIf` is read when
 * the file is collected, which is before any hook has run, so a flag set in a
 * hook would skip every case on a machine where the emulator is up.
 */
const up = await (async () => {
  try {
    return (await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();
if (!up) process.stderr.write(`[whatsapp] no emulator at ${URL_BASE}; its integration cases are skipped. Start it with \`npm run whatsapp:emulator\`.\n`);

/** A fresh phone-number id per case, because the emulator keys a conversation on it. */
const pnid = () => `9${String(Math.floor(Math.random() * 1e11)).padStart(11, "0")}`;
const TO = "5511987654321";

const config = (phoneNumberId: string): CloudApiConfig => ({
  baseUrl: URL_BASE,
  phoneNumberId,
  accessToken: "emulator",
  verifyToken: "emulator",
  appSecret: "dev",
  apiVersion: "v22.0",
  webhookPort: 0,
});

async function send(phoneNumberId: string, body: Parameters<typeof buildSendRequest>[2]) {
  const request = buildSendRequest(config(phoneNumberId), `+${TO}`, body);
  if ("unsupported" in request) return { status: 0, unsupported: request.unsupported, body: null as unknown };
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  return { status: response.status, unsupported: null, body: (await response.json()) as Record<string, unknown> };
}

async function raw(path: string, init?: RequestInit) {
  const response = await fetch(`${URL_BASE}${path}`, init);
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

describe.skipIf(!up)("what our adapter depends on, and the emulator provides", () => {
  // Free-form text goes only inside a window the person opened, at Meta and on
  // 0.2.0 alike, so these two open one first. Before 0.2.0 they passed without
  // it, which was gap (a) hiding inside the tests of what works.
  it("answers our text send with the Cloud API's own response shape", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const result = await send(id, { kind: "text", text: "Oi, Joana!" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ messaging_product: "whatsapp" });
    const messages = (result.body as { messages: Array<{ id: string; message_status: string }> }).messages;
    expect(messages[0]!.id).toMatch(/^wamid\./);
    expect(messages[0]!.message_status).toBe("accepted");
  });

  it("takes the Pix copy-and-paste as a plain text message: the string that pays goes through unchanged", async () => {
    const brcode = "00020126580014br.gov.bcb.pix0136stub-chg_abc5204000053039865802BR5909CODESPAR6009SAO PAULO62070503***6304STUB";
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const result = await send(id, { kind: "instrument", instrument: "pix_copy_paste", value: brcode });
    expect(result.status).toBe(200);
  });

  it("takes a template with its body parameters", async () => {
    const result = await send(pnid(), { kind: "template", template: "cobranca_lembrete", language: "pt_BR", variables: ["Joana"] });
    expect(result.status).toBe(200);
  });

  it("has a conversation clock we can pin and move, which is the only way a 24h window ever closes in a replay", async () => {
    const driver = new EmulatorDriver(URL_BASE);
    const pinned = (await driver.pin(new Date("2026-09-23T17:00:00.000Z"))) as { now: string };
    expect(pinned.now).toBe("2026-09-23T17:00:00.000Z");
    const moved = (await driver.advanceHours(26)) as { now: string };
    expect(Date.parse(moved.now) - Date.parse(pinned.now)).toBeGreaterThanOrEqual(26 * 3600 * 1000);
  });

  it("delivers an inbound message as a webhook our own parser reads", async () => {
    const id = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi, recebi a mensagem" });
    const { body } = await raw("/_sim/webhooks");
    const deliveries = (body as { deliveries: Array<{ body: unknown }> }).deliveries;
    const mine = deliveries.map((d) => d.body).filter((b) => JSON.stringify(b).includes(id));
    expect(mine.length).toBeGreaterThan(0);
  });
});

/** Every webhook the emulator has dispatched, in order. The index a redelivery names is the position here. */
async function deliveries(): Promise<Array<{ body: unknown; replayOf?: number }>> {
  return ((await raw("/_sim/webhooks")).body as { deliveries: Array<{ body: unknown; replayOf?: number }> }).deliveries;
}

async function post(path: string, body: unknown) {
  return raw(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

type Conversation = { messages: Array<{ id: string; bodyPreview?: string; status?: string }>; priced: { total: number; byMessageId: Record<string, { reasonCode: string }> } };

async function conversation(key: string): Promise<Conversation> {
  return (await raw(`/_sim/state?key=${encodeURIComponent(key)}`)).body as unknown as Conversation;
}

/** The inbound messages one delivery carries, the way Meta shapes them. */
function inboundOf(delivery: { body: unknown }) {
  const body = delivery.body as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<Record<string, unknown>> } }> }> };
  return body.entry?.[0]?.changes?.[0]?.value?.messages ?? [];
}

describe.skipIf(!up)("the five gaps 0.2.0 closed, asked of the binary", () => {
  it("(a) refuses a free-form message outside the 24h window with Meta's 131047, records nothing and fires no webhook", async () => {
    const id = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    expect((await send(id, { kind: "text", text: "dentro da janela" })).status).toBe(200);

    await driver.advanceHours(26);
    const before = await conversation(`${id}:${TO}`);
    const hooksBefore = (await deliveries()).length;
    const outside = await send(id, { kind: "text", text: "Recebemos, acordo quitado." });
    expect(outside.status).toBe(400);
    const error = (outside.body as { error: { code: number; error_data: { details: string } } }).error;
    expect(error.code).toBe(131047);
    expect(error.error_data.details).toMatch(/window/);
    // Refused, not recorded-and-refused: no message and no webhook.
    const after = await conversation(`${id}:${TO}`);
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(after.messages.some((m) => m.bodyPreview === "Recebemos, acordo quitado.")).toBe(false);
    expect((await deliveries()).length).toBe(hooksBefore);

    // The rule, not a blanket refusal: a template in the same shut window goes.
    expect((await send(id, { kind: "template", template: "acordo_quitado", language: "pt_BR", variables: ["acordo-1042"] })).status).toBe(200);
  });

  it("(a) and our adapter reads that refusal as the window rule, which is what lets the poll answer it with a template", async () => {
    const id = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    await driver.advanceHours(26);
    const backend = new WhatsAppCloudApi({ config: config(id), conversation: { contact: `+${TO}` }, say: () => undefined });
    const sent = await backend.deliver(`+${TO}`, { kind: "text", text: "Recebemos, acordo quitado." });
    expect(sent.state).toBe("failed");
    expect(sent.refused?.rule).toBe("session_window_closed");
    expect(sent.refused?.detail).toContain("131047");
  });

  it("(b) redelivers one webhook: the same body, marked `replayOf`, appended under a NEW index", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const list = await deliveries();
    const index = list.length - 1;
    expect(JSON.stringify(list[index]!.body)).toContain(id);

    const { status, body } = await post(`/_sim/webhooks/${index}/redeliver`, {});
    expect(status).toBe(200);
    expect((body as { delivery: { replayOf: number } }).delivery.replayOf).toBe(index);

    // Gotcha one: the redelivery is itself a delivery, at the end of the list.
    const after = await deliveries();
    expect(after.length).toBe(list.length + 1);
    expect(after[after.length - 1]!.replayOf).toBe(index);
    // A duplicate, which is what Meta sends: same message id, not a second message.
    expect(after[after.length - 1]!.body).toEqual(list[index]!.body);
  });

  it("(b) replays several in the order asked, duplicates included, so out-of-order delivery can be driven", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "primeira" });
    const a = (await deliveries()).length - 1;
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "segunda" });
    const b = (await deliveries()).length - 1;
    const before = (await deliveries()).length;

    const { status } = await post("/_sim/replay", { indexes: [b, a, a] });
    expect(status).toBe(200);
    const replayed = (await deliveries()).slice(before);
    expect(replayed.map((d) => d.replayOf)).toEqual([b, a, a]);
    expect(replayed.map((d) => (inboundOf(d)[0]!["text"] as { body: string }).body)).toEqual(["segunda", "primeira", "primeira"]);
  });

  it("(b) gotcha two: a missing index mid-replay answers 404, and the ones BEFORE it were already redelivered", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const a = (await deliveries()).length - 1;
    const before = (await deliveries()).length;
    const missing = before + 1000;

    const { status, body } = await post("/_sim/replay", { indexes: [a, missing, a] });
    expect(status).toBe(404);
    expect((body as { error: { message: string } }).error.message).toMatch(/there are \d+/);
    // Not atomic: the first went out, the third did not.
    const after = await deliveries();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.replayOf).toBe(a);
  });

  it("(b) and our receiver hands a redelivered message on once, which is what Meta's at-least-once delivery needs of it", async () => {
    const id = pnid();
    const backend = new WhatsAppCloudApi({ config: { ...config(id), webhookPort: EMULATOR_DEFAULTS.webhookPort }, conversation: { contact: `+${TO}` }, say: () => undefined });
    await backend.open();
    try {
      await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "fechado, pago à vista" });
      const index = (await deliveries()).length - 1;
      const redelivered = await post(`/_sim/webhooks/${index}/redeliver`, {});
      // Signed like the original, so it reached us and was verified — the drop below is ours, not a bad signature.
      expect((redelivered.body as { delivery: { status: number } }).delivery.status).toBe(200);
      expect((await backend.next())?.text).toBe("fechado, pago à vista");
      const second = await Promise.race([backend.next(), new Promise((resolve) => setTimeout(() => resolve("nothing"), 300))]);
      expect(second).toBe("nothing");
    } finally {
      await backend.close();
    }
  });

  it("(c) keys a conversation on the digits: `+55…` inbound and `55…` outbound are one person, and a `+` key still finds it", async () => {
    const id = pnid();
    // By hand, with the `+` Meta never sends and the emulator's own default uses.
    await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, text: "oi" });
    await send(id, { kind: "text", text: "resposta" });
    const keys = ((await raw(`/_sim/state?key=${id}:not-a-conversation`)).body as { keys: string[] }).keys;
    expect(keys.filter((k) => k.startsWith(`${id}:`))).toEqual([`${id}:${TO}`]);
    const withPlus = await conversation(`${id}:+${TO}`);
    expect(withPlus.messages.map((m) => m.bodyPreview)).toEqual(["oi", "resposta"]);
    // And the inbound webhook carries `from` the way Meta does, without the `+`.
    const mine = (await deliveries()).filter((d) => JSON.stringify(d.body).includes(id)).flatMap(inboundOf);
    expect(mine.map((m) => m["from"])).toEqual([TO]);
  });

  it("(d) emits `read` and `failed` on demand; a failure carries 131026 and leaves the bill", async () => {
    const id = pnid();
    const key = `${id}:${TO}`;
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    await driver.advanceHours(26);
    // Two templates outside the window, both billed, so the total can visibly rise and then fall.
    const template = { kind: "template" as const, template: "acordo_quitado", language: "pt_BR", variables: ["acordo-1042"] };
    const first = ((await send(id, template)).body as { messages: Array<{ id: string }> }).messages[0]!.id;
    await send(id, template);
    const billed = (await conversation(key)).priced.total;
    expect(billed).toBeGreaterThan(0);

    const statusesFor = async (message: string) =>
      (await deliveries())
        .map((d) => d.body as { entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id: string; status: string; errors?: Array<{ code: number; error_data?: { details?: string } }> }> } }> }> })
        .flatMap((b) => b.entry?.[0]?.changes?.[0]?.value?.statuses ?? [])
        .filter((s) => s.id === message);

    expect((await post("/_sim/status", { status: "read", message_id: first })).status).toBe(200);
    expect((await statusesFor(first)).map((s) => s.status)).toEqual(["sent", "delivered", "read"]);

    expect((await post("/_sim/status", { status: "failed", reason: "not on whatsapp", message_id: first })).status).toBe(200);
    const failed = (await statusesFor(first)).at(-1)!;
    expect(failed.status).toBe("failed");
    expect(failed.errors?.[0]?.code).toBe(131026);
    expect(failed.errors?.[0]?.error_data?.details).toBe("not on whatsapp");

    const after = await conversation(key);
    expect(after.priced.byMessageId[first]!.reasonCode).toBe("NOT_BILLABLE_FAILED");
    expect(after.priced.total).toBeLessThan(billed);
    expect(after.priced.total).toBeGreaterThan(0);
  });

  it("(e) carries an interactive reply through as Meta's `interactive` object, id preserved, and refuses one without an id", async () => {
    const id = pnid();
    const replies = [
      { type: "button_reply", button_reply: { id: "avista", title: "À vista" } },
      { type: "list_reply", list_reply: { id: "3x", title: "3x" } },
      { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: '{"plano":"3x"}' } },
    ];
    for (const interactive of replies) {
      expect((await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, type: "interactive", interactive })).status).toBe(200);
      const last = inboundOf((await deliveries()).at(-1)!)[0]!;
      expect(last["type"]).toBe("interactive");
      expect(last["interactive"]).toEqual(interactive);
    }

    const before = (await deliveries()).length;
    const noId = await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, type: "interactive", interactive: { type: "button_reply", button_reply: { title: "À vista" } } });
    expect(noId.status).toBe(400);
    const noJson = await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { name: "flow" } } });
    expect(noJson.status).toBe(400);
    expect((await deliveries()).length).toBe(before);
  });
});
