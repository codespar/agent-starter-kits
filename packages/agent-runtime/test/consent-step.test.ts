/**
 * What the payer reads for each consent page, and that a pull with two of
 * them in one attempt (Iniciador JSR) puts both in the conversation, in
 * order, once each. A consent link with no `consent_step` (sweeping) keeps
 * the bank's words.
 */
import { describe, expect, it } from "vitest";
import { CORE_STRINGS, type ChargeInstrument, type Execution, type ExecutionEngine } from "@codespar/agent-core";
import { WhatsAppChannel } from "../src/channels/whatsapp/index.js";
import { consentCta, instrumentBodies } from "../src/channels/whatsapp/present.js";
import type { ChannelBackend, InboundMessage, OutboundBody, SentMessage } from "../src/channels/types.js";
import { pollUntilClosed } from "../src/poll.js";

function consent(url: string, step?: ChargeInstrument["consent_step"]): ChargeInstrument {
  return { payable: true, status: "PENDING", pix_copy_paste: null, boleto_bank_line: null, boleto_bar_code: null, due_date: null, consent_url: url, ...(step ? { consent_step: step } : {}) };
}

const EXECUTION = { id: "exe_1", items: [{ amount: 100 }] } as unknown as Execution;

function ctaOf(instrument: ChargeInstrument) {
  const link = instrumentBodies(EXECUTION, 1, "auth_1", instrument, "BRL").find((b) => b.kind === "instrument");
  return link && link.kind === "instrument" ? { value: link.value, cta: link.cta } : undefined;
}

describe("the words on a consent link", () => {
  const pt = CORE_STRINGS["pt-BR"];

  it("no step: the bank's page, as before", () => {
    expect(ctaOf(consent("https://bank.example/consent"))).toEqual({ value: "https://bank.example/consent", cta: { body: pt.consentPrompt, button: pt.consentButton, lead: pt.consentLink } });
  });

  it("enroll: register the biometrics, about 1 minute", () => {
    expect(ctaOf(consent("https://bank.example/par", "enroll"))?.cta).toEqual({ body: pt.enrollPrompt, button: pt.enrollButton, lead: pt.enrollLink });
    expect(pt.enrollPrompt).toContain("1 minuto");
  });

  it("sign: confirm with the phone's biometrics, about 10 minutes", () => {
    expect(ctaOf(consent("https://app.example/pay/1", "sign"))?.cta).toEqual({ body: pt.signPrompt, button: pt.signButton, lead: pt.signLink });
    expect(pt.signPrompt).toContain("10 minutos");
  });

  it("every step's button fits WhatsApp's 20 characters, in each locale", () => {
    for (const locale of ["pt-BR", "en"] as const) {
      for (const step of ["enroll", "sign"] as const) expect(consentCta(step, locale).button.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("two consent pages in one attempt", () => {
  it("the poll presents the enroll page, then the sign page, once each", async () => {
    // The rail's view of one attempt over five looks: the enrollment link, the same again, the payment link, the same again, paid.
    const views: Array<ChargeInstrument | "settled"> = [consent("https://bank.example/par", "enroll"), consent("https://bank.example/par", "enroll"), consent("https://app.example/pay/1", "sign"), consent("https://app.example/pay/1", "sign"), "settled"];
    let look = 0;
    const execution = (): Execution => {
      const view = views[Math.min(look, views.length - 1)]!;
      return (
        view === "settled"
          ? { id: "exe_1", state: "settled", outcomes: [{ index: 0, attempt_id: "att_1_0", status: "settled", transaction_id: "E2E" }] }
          : { id: "exe_1", state: "executing", outcomes: [{ index: 0, attempt_id: "att_1_0", status: "accepted", transaction_id: "auth_1", instrument: view }] }
      ) as unknown as Execution;
    };
    const shown = new Set<string>();
    const engine = {
      get: () => execution(),
      reconcile: async () => ((look += 1), execution()),
      markShown: (executionId: string, attemptId: string, step?: string) => !shown.has(`${executionId}:${attemptId}:${step ?? ""}`) && Boolean(shown.add(`${executionId}:${attemptId}:${step ?? ""}`)),
      note: () => undefined,
    } as unknown as ExecutionEngine;
    const presented: Array<{ url: string | null | undefined; step: string | undefined }> = [];
    const result = await pollUntilClosed(engine, "exe_1", { intervalMs: 0, timeoutMs: 0, maxRounds: 10, onInstrument: (_e, _n, _id, i) => void presented.push({ url: i.consent_url, step: i.consent_step }) });
    expect(presented).toEqual([
      { url: "https://bank.example/par", step: "enroll" },
      { url: "https://app.example/pay/1", step: "sign" },
    ]);
    expect(result.execution.state).toBe("settled");
  });
});

describe("a consent link in the channel log", () => {
  it("the person gets the whole link; channel.jsonl keeps where it pointed, never its query", async () => {
    const delivered: OutboundBody[] = [];
    const inbox: InboundMessage[] = [{ id: "wamid.in.1", from: "+5511900000001", text: "sim", timestamp: Date.parse("2026-10-28T15:00:00Z") / 1000 }];
    const backend: ChannelBackend = {
      name: "scripted",
      live: false,
      open: async () => undefined,
      next: async () => inbox.shift(),
      deliver: async (_to: string, body: OutboundBody): Promise<SentMessage> => (delivered.push(body), { id: `wamid.out.${delivered.length}`, state: "sent" }),
      onStatus: () => undefined,
      close: async () => undefined,
    };
    const channel = new WhatsAppChannel({ backend, conversation: { contact: "+5511900000001" }, now: () => new Date("2026-10-28T15:00:05Z"), templates: [] });
    await channel.next();
    const link = "https://app.example/agentic/pay/abc?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    await channel.send({ kind: "instrument", instrument: "consent_url", value: link, cta: consentCta("sign") });
    expect(delivered.at(-1)).toMatchObject({ value: link });
    const logged = JSON.stringify(channel.log());
    expect(logged).toContain("https://app.example/agentic/pay/abc?<redacted>");
    expect(logged).not.toContain("token=");
    expect(logged).not.toContain("eyJ");
  });
});
