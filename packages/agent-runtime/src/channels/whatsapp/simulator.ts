/**
 * The house simulator: WhatsApp's SHAPE, with no network, no Meta account and
 * no credential anywhere.
 *
 * It is the first backend on purpose. A conversation channel is the one place
 * where "it works on my machine" and "it works" are furthest apart, and the
 * only way to put a whole collection cycle under a CI gate is to have
 * something that speaks the same shape and answers the same refusals without
 * an account. So this obeys the rules that would bite in production — the
 * 24-hour session window, template-only outside it, one contact per
 * conversation — rather than accepting everything and being useless.
 *
 * What it is NOT: a WhatsApp client. It does not encrypt, does not deliver to
 * a phone, and its message ids are deliberately `sim_...` and never
 * `wamid....`, so nothing downstream can mistake a simulated act for an
 * observed one. That distinction is what the consent-evidence seam turns on.
 *
 * Deterministic by construction: ids are a counter, the clock is the run's
 * (`--now`), and the person's turns come from a conversation file. Drive it
 * from a script and the same run produces the same bundle; drive it from the
 * keyboard and it is a chat window on stderr.
 */
import qrcode from "qrcode-terminal";
import type { ConversationScript } from "@codespar/agent-core";
import type { ChannelBackend, DeliveryState, InboundMessage, OutboundBody, SentMessage } from "../types.js";

export interface SimulatorOptions {
  conversation: { contact: string; subject?: string | undefined };
  /** The person's turns. Absent means the person is at the keyboard. */
  script?: ConversationScript | undefined;
  /** The run's clock, so a scripted conversation is reproducible. */
  now: () => Date;
  /** Where the simulated phone is drawn. The operator's console, never the conversation. */
  render: (line: string) => void;
  /** Interactive only: reads the person's next line. */
  ask?: ((question: string) => Promise<string>) | undefined;
}

const PREFIX = "  │ ";

export class WhatsAppSimulator implements ChannelBackend {
  readonly name = "simulator";
  readonly live = false;
  private turn = 0;
  private outbound = 0;
  private inbound = 0;
  private closed = false;

  constructor(private readonly options: SimulatorOptions) {}

  async open(): Promise<void> {
    const { contact, subject } = this.options.conversation;
    this.options.render("");
    this.options.render(`  ┌─ WhatsApp (simulador da casa — sem rede, sem conta Meta) ─ ${maskContact(contact)}${subject ? ` · ${subject}` : ""}`);
  }

  async next(): Promise<InboundMessage | undefined> {
    if (this.closed) return undefined;
    const script = this.options.script;
    let text: string;
    if (script) {
      const turn = script.turns[this.turn];
      if (!turn) return undefined;
      this.turn += 1;
      text = turn.text;
    } else {
      if (!this.options.ask) return undefined;
      let answer: string;
      try {
        answer = await this.options.ask(`${PREFIX}voce (${maskContact(this.options.conversation.contact)})> `);
      } catch {
        return undefined;
      }
      text = answer.trim();
      if (!text) return this.next();
      if (["sair", "exit", "quit"].includes(text.toLowerCase())) return undefined;
    }
    this.inbound += 1;
    const message: InboundMessage = {
      id: `sim_in_${String(this.inbound).padStart(4, "0")}`,
      from: this.options.conversation.contact,
      text,
      timestamp: Math.floor(this.options.now().getTime() / 1000),
    };
    if (script) this.options.render(`${PREFIX}${maskContact(message.from)}: ${text}`);
    return message;
  }

  async deliver(_to: string, body: OutboundBody): Promise<SentMessage> {
    this.outbound += 1;
    const id = `sim_out_${String(this.outbound).padStart(4, "0")}`;
    for (const line of this.screen(body)) this.options.render(`${PREFIX}${line}`);
    return { id, state: this.deliveryState() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.options.render("  └─ fim da conversa");
  }

  /**
   * `read` while the person still has something to say — they are looking at
   * the phone — and `delivered` once they do not. Both are states the real
   * provider reports; neither is invented, and which one comes back is
   * decided by the script rather than by a timer, so a run is reproducible.
   */
  private deliveryState(): DeliveryState {
    const script = this.options.script;
    if (!script) return "delivered";
    return this.turn < script.turns.length ? "read" : "delivered";
  }

  private screen(body: OutboundBody): string[] {
    switch (body.kind) {
      case "text":
        return [`loja: ${body.text}`];
      case "instrument":
        return [`loja: [${body.instrument === "pix_copy_paste" ? "Pix copia e cola" : "linha digitavel"}]`, `loja: ${body.value}`];
      case "template":
        return [`loja: [template ${body.template} (${body.language})] ${body.variables.join(" | ")}`];
      case "media": {
        const lines = [`loja: [imagem: QR Pix]`];
        qrcode.generate(body.data, { small: true }, (qr: string) => {
          for (const line of qr.split("\n")) if (line.trim()) lines.push(line);
        });
        if (body.caption) lines.push(`loja: ${body.caption}`);
        return lines;
      }
    }
  }
}

/** `+5511987654321` -> `+55 11 ****4321`. What reaches the console and the bundle. */
export function maskContact(contact: string): string {
  if (!contact.startsWith("+") || contact.length < 8) return "***";
  return `${contact.slice(0, 5)} ****${contact.slice(-4)}`;
}
