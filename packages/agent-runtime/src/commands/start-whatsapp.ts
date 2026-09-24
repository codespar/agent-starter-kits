/**
 * `codespar-agent start --channel whatsapp`: wiring, and only wiring.
 *
 * It picks a backend, binds the conversation, hands the channel the rules the
 * agent's own guardrails declare, and runs the loop. The decisions are all
 * elsewhere: the rules in `channels/rules.ts`, the session window in
 * `channels/whatsapp/session.ts`, the gates in `terminal.ts`, which this path
 * reuses unchanged so the two channels cannot drift on what may execute.
 */
import { stdout } from "node:process";
import { relative } from "node:path";
import type { ConversationScript } from "@codespar/agent-core";
import type { Agent } from "../agent.js";
import type { Setup } from "../setup.js";
import { defaultAsk } from "../terminal.js";
import { knownSubjects } from "../channels/index.js";
import { converse } from "../channels/whatsapp/run.js";
import { WhatsAppChannel } from "../channels/whatsapp/index.js";
import { WhatsAppCloudApi, loadCloudApiConfig } from "../channels/whatsapp/cloud-api.js";
import { WhatsAppSimulator } from "../channels/whatsapp/simulator.js";
import type { ChannelBackend } from "../channels/types.js";

export type WhatsAppBackendName = "simulator" | "cloud-api";

export interface StartWhatsAppOptions {
  agent: Agent;
  setup: Setup;
  script: ConversationScript;
  backend: WhatsAppBackendName;
  /** Replay the conversation's turns; otherwise the person is at the keyboard. */
  scripted: boolean;
  approver: { id: string; channel: string };
  json: boolean;
  startedAt: number;
  say: (line: string) => void;
  decision?: "approve" | "deny" | "none";
  waitSeconds?: number | undefined;
  simulatePayer?: boolean | undefined;
  now?: (() => Date) | undefined;
}

export async function startWhatsApp(options: StartWhatsAppOptions): Promise<number> {
  const { agent, setup: s, script, say } = options;
  const now = options.now ?? (() => new Date());
  const conversation = { contact: script.contact, subject: script.subject };

  // A scripted conversation has nobody at a keyboard, and in `human` mode
  // somebody has to decide. Refused rather than left waiting on a stdin that
  // will never answer: a gate that hangs teaches nothing.
  if (options.scripted && s.mode === "human" && !options.decision) {
    say("--scripted has nobody at the keyboard and approval: human needs a decision: add --approve or --deny, or run --mode mandate");
    return 2;
  }

  let backend: ChannelBackend;
  if (options.backend === "cloud-api") {
    const { config, missing } = loadCloudApiConfig(process.env);
    if (!config) {
      say(`the cloud-api backend needs credentials this repo ships none of: ${missing.join(", ")}.`);
      say(`They live in the agent's .env (commented out in .env.example) and belong to a Meta Business account. The house simulator needs none: drop --backend cloud-api.`);
      return 1;
    }
    say("[whatsapp] cloud-api backend: this repo has never run one against Meta. The shapes are written from the published documentation; the first live run is yours.");
    backend = new WhatsAppCloudApi({ config, conversation: { contact: script.contact }, say });
  } else {
    backend = new WhatsAppSimulator({
      conversation,
      ...(options.scripted ? { script } : {}),
      now,
      render: say,
      ...(options.scripted ? {} : { ask: defaultAsk }),
    });
  }

  // The hours are the agent's, from `guardrails.envelope.collection_hours`. An agent that declares none gets no hours rule, which is correct: not every conversation is a collection.
  const window = typeof s.guardrails.envelope?.["collection_hours"] === "string" ? (s.guardrails.envelope["collection_hours"] as string) : undefined;

  const channel = new WhatsAppChannel({
    backend,
    conversation,
    now,
    ...(window ? { hours: { window, timezone: s.guardrails.timezone } } : {}),
    knownSubjects: knownSubjects(agent),
    bundle: s.bundle,
    say,
  });

  const result = await converse({
    setup: s,
    channel,
    approver: options.approver,
    say,
    ...(options.decision ? { decision: options.decision } : {}),
    ...(options.scripted ? {} : { ask: defaultAsk }),
    ...(options.waitSeconds !== undefined ? { waitSeconds: options.waitSeconds } : {}),
    ...(options.simulatePayer !== undefined ? { simulatePayer: options.simulatePayer } : {}),
  });

  const log = channel.log();
  const refused = log.filter((l) => l.refused).map((l) => ({ rule: l.refused!.rule, detail: l.refused!.detail }));
  const channelSummary = {
    name: "whatsapp",
    backend: channel.backend,
    conversation: script.name,
    turns: result.turns,
    messages_in: log.filter((l) => l.direction === "in").length,
    messages_out: log.filter((l) => l.direction === "out" && !l.refused).length,
    refused,
    log: relative(process.cwd(), `${s.bundle.dir}/channel.jsonl`),
  };

  if (options.json) {
    const payload = s.kit.oneShotPayload({
      setup: s,
      reply: result.replies[result.replies.length - 1] ?? "",
      toolCalls: result.toolCalls,
      executions: result.executions,
      startedAt: options.startedAt,
    });
    stdout.write(JSON.stringify({ ...payload, channel: channelSummary }) + "\n");
  } else {
    say(`conversa em ${channelSummary.log} — ${channelSummary.messages_in} recebida(s), ${channelSummary.messages_out} enviada(s)${refused.length ? `, ${refused.length} recusada(s)` : ""}`);
  }

  return result.executions.some((e) => e.state === "executing") ? 3 : 0;
}
