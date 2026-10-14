/**
 * A second harness: the same tool-use loop on `@google/genai`. Like the
 * Anthropic one, it only turns messages into a request and the response into
 * tool calls or a reply; it never decides anything about money. The mandate,
 * the guardrails and `tools.json` stay the core's, so switching the model to
 * Gemini changes nothing about what can be paid.
 */
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import type { AgentRuntime, ConversationMessage, Reply, ToolCall, ToolSpec, Turn } from "./types.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";

export interface GeminiRuntimeOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
}

export class GeminiRuntime implements AgentRuntime {
  readonly name = "gemini";
  readonly model: string;
  private readonly client: GoogleGenAI;
  /**
   * The model's own turn, kept verbatim by the id of each call it made.
   * Gemini 2.5 and 3 attach a `thoughtSignature` to function-call parts and
   * expect it back on the next request; the shared conversation type has no
   * slot for it, so the turn that produced a call is replayed as it came.
   */
  private readonly modelTurns = new Map<string, Content>();
  private callCounter = 0;

  constructor(options: GeminiRuntimeOptions = {}) {
    const apiKey = options.apiKey ?? process.env["GEMINI_API_KEY"];
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set; use the replay provider for runs without a model");
    this.client = new GoogleGenAI({ apiKey });
    this.model = options.model || process.env["GEMINI_MODEL"] || DEFAULT_GEMINI_MODEL;
  }

  async step(input: Turn, tools: ToolSpec[]): Promise<ToolCall[] | Reply> {
    const request = {
      model: this.model,
      contents: toGeminiContents(input.messages, this.modelTurns),
      config: {
        systemInstruction: input.system,
        tools: [{ functionDeclarations: tools.map(toGeminiDeclaration) }],
      },
    };
    const response = await withRetry(() => this.client.models.generateContent(request));
    const content = response.candidates?.[0]?.content;
    const calls: ToolCall[] = [];
    const text: string[] = [];
    for (const part of content?.parts ?? []) {
      if (part.functionCall?.name) {
        const id = part.functionCall.id ?? `gemini_${++this.callCounter}`;
        calls.push({ id, name: part.functionCall.name, input: part.functionCall.args ?? {} });
      } else if (part.text && !part.thought) {
        text.push(part.text);
      }
    }
    if (calls.length > 0) {
      const turn: Content = { role: "model", parts: withCallIds(content?.parts ?? [], calls) };
      for (const call of calls) this.modelTurns.set(call.id, turn);
      return calls;
    }
    return { text: text.join("\n").trim() };
  }
}

export function toGeminiDeclaration(tool: ToolSpec): FunctionDeclaration {
  return { name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema };
}

/** Stamps the ids this runtime handed out onto the function-call parts, so the replayed turn and the responses agree. */
function withCallIds(parts: Part[], calls: ToolCall[]): Part[] {
  let i = 0;
  return parts.map((part) => {
    if (!part.functionCall?.name) return part;
    const call = calls[i++];
    return call ? { ...part, functionCall: { ...part.functionCall, id: call.id } } : part;
  });
}

/**
 * The shared conversation as Gemini contents: `user` text, `model` turns with
 * text and function calls, and consecutive tool results grouped into one
 * `user` turn of function responses. A model turn whose calls this runtime
 * produced is replayed verbatim from `modelTurns` (see the class comment).
 */
export function toGeminiContents(messages: ConversationMessage[], modelTurns: ReadonlyMap<string, Content> = new Map()): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      const kept = m.tool_calls?.map((c) => modelTurns.get(c.id)).find((c) => c !== undefined);
      if (kept) {
        out.push(kept);
        continue;
      }
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.tool_calls ?? []) parts.push({ functionCall: { id: call.id, name: call.name, args: call.input } });
      out.push({ role: "model", parts });
    } else {
      const part: Part = {
        functionResponse: { id: m.tool_call_id, name: m.name, response: m.is_error ? { error: m.content } : { content: m.content } },
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && (last.parts ?? []).length > 0 && (last.parts ?? []).every((p) => p.functionResponse)) {
        (last.parts ??= []).push(part);
      } else {
        out.push({ role: "user", parts: [part] });
      }
    }
  }
  return out;
}

/**
 * Rate limits and overload (429, 500, 503) are the model's availability, not a
 * decision: wait and ask again, a bounded number of times, then let the error
 * surface. Nothing about money is retried here; this only repeats a model call.
 */
export const RETRY_DELAYS_MS = [2_000, 6_000, 15_000, 30_000];
const RETRYABLE = new Set([429, 500, 503]);

export async function withRetry<T>(call: () => Promise<T>, delays: number[] = RETRY_DELAYS_MS, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === undefined || !RETRYABLE.has(status) || attempt >= delays.length) throw err;
      await sleep(delays[attempt] ?? 0);
    }
  }
}
