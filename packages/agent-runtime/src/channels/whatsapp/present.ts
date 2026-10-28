/**
 * How a payable receivable is put into a conversation.
 *
 * It is here, and not inside the run loop, because two commands now present
 * one: the run that issues the charge, and the poll that comes back to it
 * later. A payer told how to pay by a poll must be told the same way as a
 * payer told by a run, and the only way to guarantee that is for both to
 * build the same messages from the same place.
 *
 * The shape is the point. The QR goes as an IMAGE and the copy-and-paste as
 * its OWN message underneath, because a code inside a picture cannot be
 * copied and a code inside a paragraph cannot be tapped.
 */
import { CORE_STRINGS, formatDay, type ChargeInstrument, type Execution, type Locale } from "@codespar/agent-core";
import type { OutboundBody } from "../types.js";

export function instrumentBodies(execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument, currency: string, locale: Locale = "pt-BR"): OutboundBody[] {
  const text = CORE_STRINGS[locale];
  const money = new Intl.NumberFormat(locale === "en" ? "en-US" : "pt-BR", { style: "currency", currency });
  const item = execution.items[instalment - 1];
  const count = execution.items.length;
  const bodies: OutboundBody[] = [
    {
      kind: "text",
      text: [
        count > 1 ? text.instalmentOf(instalment, count) : "",
        item ? money.format(item.amount / 100) : "",
        instrument.due_date ? text.dueOn(formatDay(instrument.due_date, locale)) : "",
        // A pull's id is the bank authorization's, which means nothing to the person; the link below is what they act on.
        instrument.consent_url ? "" : text.chargeRef(chargeId),
      ].join(""),
    },
  ];
  if (instrument.pix_copy_paste) {
    bodies.push({ kind: "media", media: "qr", data: instrument.pix_copy_paste });
    bodies.push({ kind: "instrument", instrument: "pix_copy_paste", value: instrument.pix_copy_paste });
  }
  if (instrument.consent_url) {
    // One message: the link is a button to tap, not a string to copy. The backend falls back to the lead line and the bare link.
    bodies.push({ kind: "instrument", instrument: "consent_url", value: instrument.consent_url, cta: consentCta(instrument.consent_step, locale) });
  }
  if (instrument.boleto_bank_line) {
    bodies.push({ kind: "text", text: text.boletoLine });
    bodies.push({ kind: "instrument", instrument: "boleto_bank_line", value: instrument.boleto_bank_line });
  }
  return bodies;
}

/** The words on a consent link's button: the bank's one page, or which of a JSR pull's two it is. */
export function consentCta(step: ChargeInstrument["consent_step"], locale: Locale = "pt-BR"): { body: string; button: string; lead: string } {
  const text = CORE_STRINGS[locale];
  if (step === "enroll") return { body: text.enrollPrompt, button: text.enrollButton, lead: text.enrollLink };
  if (step === "sign") return { body: text.signPrompt, button: text.signButton, lead: text.signLink };
  return { body: text.consentPrompt, button: text.consentButton, lead: text.consentLink };
}

