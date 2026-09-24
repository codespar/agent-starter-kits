/**
 * The WhatsApp channel: one adapter, two backends.
 *
 * Everything that decides what may be said lives HERE and not in a backend,
 * which is what makes "the rules are code" true rather than aspirational.
 * Picking the simulator or the official API changes who carries the bytes; it
 * does not change the hours, the bound contact, the secrecy of the debt, the
 * document rule or the session window. A test that tries to get around a rule
 * by choosing a backend is in `test/whatsapp-rules.test.ts` and fails.
 *
 * It also keeps the two audiences apart. `send` reaches the person who owes.
 * The operator's console and the approval question are wired to stderr by the
 * caller and have no path to this object at all — not a check, a shape: there
 * is no method here that an operator line could be handed to.
 */
import type { ProofBundle } from "@codespar/agent-core";
import { checkOutbound, type HoursRule, type RuleContext } from "../rules.js";
import type { Channel, ChannelBackend, ChannelLogLine, Conversation, InboundMessage, OutboundBody, SentMessage } from "../types.js";
import { maskContact } from "./simulator.js";
import { SessionWindow } from "./session.js";

export interface WhatsAppChannelOptions {
  backend: ChannelBackend;
  conversation: Conversation;
  now: () => Date;
  hours?: HoursRule | undefined;
  knownSubjects?: readonly string[] | undefined;
  /** The run's bundle, so the conversation is part of the proof. */
  bundle?: ProofBundle | undefined;
  /** Templates the agent declares it uses. Meta's approval of them is not knowable from here. */
  templates?: readonly string[] | undefined;
  /** The operator's console. Refusals are reported here, never to the conversation. */
  say?: ((line: string) => void) | undefined;
}

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;
  readonly conversation: Conversation;
  private readonly session: SessionWindow;
  private readonly lines: ChannelLogLine[] = [];
  private lastInbound: InboundMessage | undefined;

  constructor(private readonly options: WhatsAppChannelOptions) {
    this.conversation = options.conversation;
    this.session = new SessionWindow(new Set(options.templates ?? []));
  }

  get backend(): string {
    return this.options.backend.name;
  }

  /** Whether the backend talks to a real provider. What the consent-evidence seam turns on. */
  get live(): boolean {
    return this.options.backend.live;
  }

  /** The message the person last sent, for the caller that needs to attest to an act. */
  get lastInboundMessage(): InboundMessage | undefined {
    return this.lastInbound;
  }

  async open(): Promise<void> {
    await this.options.backend.open();
  }

  async next(): Promise<InboundMessage | undefined> {
    const message = await this.options.backend.next();
    if (!message) return undefined;
    this.lastInbound = message;
    this.session.observeInbound(message.timestamp);
    this.record({
      at: this.options.now().toISOString(),
      direction: "in",
      contact: maskContact(message.from),
      kind: "text",
      message_id: message.id,
      state: "delivered",
      text: message.text,
    });
    return message;
  }

  async send(body: OutboundBody): Promise<SentMessage> {
    const to = this.conversation.contact;
    const ctx: RuleContext = {
      conversation: this.conversation,
      hours: this.options.hours,
      now: this.options.now,
      knownSubjects: this.options.knownSubjects,
    };

    // The house rules first: a message the law refuses is not a message the provider should ever see.
    const refusal = checkOutbound(to, body, ctx) ?? this.providerRefusal(body);
    if (refusal) {
      const sent: SentMessage = { id: "", state: "failed", refused: refusal };
      this.logOutbound(body, sent);
      this.options.say?.(`  [whatsapp] recusado (${refusal.rule}): ${refusal.detail}`);
      return sent;
    }

    const sent = await this.options.backend.deliver(to, body);
    if (sent.refused) this.options.say?.(`  [whatsapp] recusado pelo backend (${sent.refused.rule}): ${sent.refused.detail}`);
    this.logOutbound(body, sent);
    return sent;
  }

  say(text: string): Promise<SentMessage> {
    return this.send({ kind: "text", text });
  }

  async close(): Promise<void> {
    await this.options.backend.close();
  }

  /** Every message of this conversation, in order. */
  log(): ReadonlyArray<ChannelLogLine> {
    return this.lines;
  }

  private logOutbound(body: OutboundBody, sent: SentMessage): void {
    this.record({
      at: this.options.now().toISOString(),
      direction: "out",
      contact: maskContact(this.conversation.contact),
      kind: body.kind,
      message_id: sent.id,
      state: sent.state,
      ...(textOf(body) !== undefined ? { text: textOf(body)! } : {}),
      ...(sent.refused ? { refused: sent.refused } : {}),
    });
  }

  /**
   * WhatsApp's own rule, enforced on both backends: outside the 24 hours
   * after the person's last message only an approved template may go out.
   * The simulator obeys it because a rule that only bites in production is a
   * rule you meet in production.
   */
  private providerRefusal(body: OutboundBody): { rule: string; detail: string } | undefined {
    const open = this.session.open(this.options.now());
    if (body.kind === "template") {
      if (!this.session.knows(body.template)) {
        return { rule: "template_unknown", detail: `the agent declares no template named ${body.template}; Meta only delivers templates it approved, and this one was never registered here` };
      }
      return undefined;
    }
    if (!open) {
      return {
        rule: "session_window_closed",
        detail: "more than 24h since the person's last message: WhatsApp only carries an approved template now, not a free-form message",
      };
    }
    return undefined;
  }

  private record(line: ChannelLogLine): void {
    this.lines.push(line);
    this.options.bundle?.channel({ ...line, channel: "whatsapp", backend: this.backend });
  }
}

function textOf(body: OutboundBody): string | undefined {
  switch (body.kind) {
    case "text":
      return body.text;
    case "instrument":
      return body.value;
    case "media":
      return body.caption;
    case "template":
      return `[template ${body.template}] ${body.variables.join(" | ")}`;
  }
}

export * from "./cloud-api.js";
export * from "./evidence.js";
export * from "./session.js";
export * from "./simulator.js";
