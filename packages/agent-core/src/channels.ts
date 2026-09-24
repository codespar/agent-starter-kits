/**
 * The channels an agent can be reached on, and the one artifact an agent
 * ships per channel.
 *
 * The NAMES live here because `agent.yaml` declares them and `npm run check`
 * has to confirm the declaration against what the agent ships; the BEHAVIOUR
 * lives in `@codespar/agent-runtime`, which owns the runner. That split is
 * the same one `tools.json` and `guardrails.json` already have: the core
 * owns the shape, the runtime owns what happens.
 *
 * `terminal` is every agent's: `npm start` opens it and needs no account.
 * `whatsapp` is the second channel, and an agent that declares it ships the
 * conversations the house simulator drives, under `channels/whatsapp/`.
 */
import { z } from "zod";

export const CHANNELS = ["terminal", "whatsapp"] as const;
export type ChannelName = (typeof CHANNELS)[number];

/** E.164, the only contact shape WhatsApp addresses. */
export const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * A scripted conversation, which is what an agent ships for a channel whose
 * other side is a person rather than a keyboard.
 *
 * It exists for two readers. The house simulator drives it with no network
 * and no account, which is what makes the WhatsApp gate runnable in the CI;
 * and `npm run check` parses it, so a conversation that no longer names a
 * contact or an agreement fails the manifest gate instead of failing a run.
 *
 * It scripts ONE side. What the agent answers comes from the model or from a
 * recorded transcript, never from here, for the same reason a scenario pack
 * asserts a final state and not a wording.
 */
export const ConversationScriptSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(1),
    channel: z.literal("whatsapp"),
    /** The contact the conversation is bound to: the person who owes, and nobody else. */
    contact: z.string().regex(E164, "contact must be E.164, e.g. +5511987654321"),
    /**
     * What this conversation is allowed to be about — an agreement alias for a
     * collections agent. The channel refuses an outbound message that names a
     * different one, which is the secrecy rule as code rather than as prose.
     */
    subject: z.string().min(1).optional(),
    /** The person's turns, in order. */
    turns: z
      .array(
        z
          .object({
            text: z.string().min(1),
            /** Seconds after the previous inbound turn, on the run's clock. Keeps a scripted run deterministic. */
            after_seconds: z.number().int().nonnegative().default(0),
          })
          .strict(),
      )
      .nonempty(),
  })
  .strict();

export type ConversationScript = z.infer<typeof ConversationScriptSchema>;

export function parseConversationScript(text: string): ConversationScript {
  return ConversationScriptSchema.parse(JSON.parse(text));
}
