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

/**
 * `CODESPAR_WA_RICH=1`: the conversation as WhatsApp renders it — the payment
 * card instead of loose codes, and a model told how a chat message reads.
 * Off by default, so the gate and the recorded transcripts are unchanged.
 */
export function richWhatsApp(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["CODESPAR_WA_RICH"] === "1";
}

export const WHATSAPP_STYLE = `## On WhatsApp

This conversation is on WhatsApp, and the person reads it on a phone. These rules override any earlier instruction about wording.

- Write like someone from the store on WhatsApp: short messages of two to four lines, plain sentences, no headings, no tables. Bold uses single asterisks (*R$ 1.020,00*), never double.
- Never write an id of any kind (charge, execution, mandate, run), a tool name, a reason code or your own name. Ids stay in the record, not in the chat.
- The payment card (with the Pix code and the boleto) and the payment confirmation are sent by the system. Do not describe the codes, and when the tool result says \`paid: true\` do not repeat the confirmation: close in one short friendly line.`;

export interface PresentOptions {
  /**
   * Send WhatsApp's own payment card (`order_details`) instead of the text
   * line, the QR image and the loose codes. Off by default: the loose shape is
   * what the gate measures, and the card needs a backend that renders it.
   */
  orderDetails?: boolean;
}

export function instrumentBodies(execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument, currency: string, locale: Locale = "pt-BR", options: PresentOptions = {}): OutboundBody[] {
  const text = CORE_STRINGS[locale];
  const money = new Intl.NumberFormat(locale === "en" ? "en-US" : "pt-BR", { style: "currency", currency });
  const item = execution.items[instalment - 1];
  const count = execution.items.length;
  if (options.orderDetails && item && (instrument.pix_copy_paste || instrument.boleto_bank_line)) {
    return [orderCard(item.amount, item.description, count > 1 ? text.instalmentOf(instalment, count).replace(/:\s*$/, "") : undefined, chargeId, instrument, currency, locale)];
  }
  const bodies: OutboundBody[] = [
    {
      kind: "text",
      text: [
        count > 1 ? text.instalmentOf(instalment, count) : "",
        item ? money.format(item.amount / 100) : "",
        instrument.due_date ? text.dueOn(formatDay(instrument.due_date, locale)) : "",
        text.chargeRef(chargeId),
      ].join(""),
    },
  ];
  if (instrument.pix_copy_paste) {
    bodies.push({ kind: "media", media: "qr", data: instrument.pix_copy_paste });
    bodies.push({ kind: "instrument", instrument: "pix_copy_paste", value: instrument.pix_copy_paste });
  }
  if (instrument.boleto_bank_line) {
    bodies.push({ kind: "text", text: text.boletoLine });
    bodies.push({ kind: "instrument", instrument: "boleto_bank_line", value: instrument.boleto_bank_line });
  }
  return bodies;
}


/**
 * The card. The charge id is the order's `reference_id`, which WhatsApp keeps
 * for the webhook and never prints; the person reads the amount, the due date
 * and what the charge is for.
 */
function orderCard(amount: number, description: string | undefined, instalment: string | undefined, chargeId: string, instrument: ChargeInstrument, currency: string, locale: Locale): OutboundBody {
  const pt = locale !== "en";
  const due = instrument.due_date ? formatDay(instrument.due_date, locale) : undefined;
  // "parcela 1/1" is not an instalment: a single payment reads as the agreement itself.
  const named = description?.replace(/\s*[-–—·,]?\s*(?:parcela|instalment)\s*1\/1\b/i, "").trim();
  const item = (instalment ? `${instalment} · ` : "") + (named || (pt ? "Acordo" : "Agreement"));
  const lines = [
    pt ? "Segue a cobrança do seu acordo." : "Here is the charge for your agreement.",
    due ? (pt ? `Vencimento: *${due}*` : `Due: *${due}*`) : "",
    pt ? "Toque em *Revisar e pagar* para copiar o código Pix ou a linha do boleto." : "Tap *Review and pay* to copy the Pix code or the boleto line.",
  ].filter(Boolean);
  const pix = instrument.pix_copy_paste ? readPix(instrument.pix_copy_paste) : undefined;
  return {
    kind: "order",
    reference: chargeId,
    body: lines.join("\n"),
    item: item.slice(0, 60),
    amountMinor: amount,
    currency,
    ...(pix ? { pix } : {}),
    ...(instrument.boleto_bank_line ? { boleto: instrument.boleto_bank_line } : {}),
  };
}

/** Merchant name (tag 59) and Pix key (tag 26, sub-tag 01) read from the BR Code itself, so the card says what the code pays. */
export function readPix(code: string): { code: string; merchantName: string; key: string; keyType: string } {
  const tags = emv(code);
  const account = tags.get("26");
  const key = account ? emv(account).get("01") ?? "" : "";
  const keyType = /^\d{14}$/.test(key) ? "CNPJ" : /^\d{11}$/.test(key) ? "CPF" : key.includes("@") ? "EMAIL" : /^\+\d+$/.test(key) ? "PHONE" : "EVP";
  // Country (58) is always "BR" right before the name (59), which survives a code whose earlier lengths are off, as the stub's are.
  const m = /5802BR59(\d{2})/.exec(code);
  const after = m ? code.slice(m.index + 10) : "";
  const city = /60\d{2}/.exec(after)?.index ?? after.length;
  const merchantName = m ? after.slice(0, Math.min(Number(m[1]), city)) : tags.get("59") ?? "";
  return { code, merchantName, key, keyType };
}

function emv(payload: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isFinite(len)) break;
    out.set(id, payload.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}
