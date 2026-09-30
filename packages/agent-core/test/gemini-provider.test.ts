/**
 * The Gemini harness only translates. These tests pin the translation: the
 * shared conversation becomes Gemini contents, tool results are grouped into
 * one function-response turn, errors travel as `error`, and the model turn
 * that produced a call goes back verbatim so its thought signature survives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Content } from "@google/genai";
import { GeminiRuntime, toGeminiContents, toGeminiDeclaration } from "../src/providers/gemini.js";
import type { ConversationMessage, ToolSpec } from "../src/providers/types.js";

const TOOL: ToolSpec = {
  name: "codespar_pay",
  description: "Pay a bill under the mandate",
  input_schema: { type: "object", properties: { beneficiary: { type: "string" }, amount: { type: "integer" } }, required: ["beneficiary", "amount"] },
};

describe("toGeminiContents", () => {
  it("maps user text, a model turn with a call, and its result", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "pague a escola de outubro" },
      { role: "assistant", content: "vou pagar", tool_calls: [{ id: "c1", name: "codespar_pay", input: { beneficiary: "Escola", amount: 120000 } }] },
      { role: "tool", tool_call_id: "c1", name: "codespar_pay", content: "{\"status\":\"awaiting_approval\"}" },
    ];
    expect(toGeminiContents(messages)).toEqual([
      { role: "user", parts: [{ text: "pague a escola de outubro" }] },
      { role: "model", parts: [{ text: "vou pagar" }, { functionCall: { id: "c1", name: "codespar_pay", args: { beneficiary: "Escola", amount: 120000 } } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "codespar_pay", response: { content: "{\"status\":\"awaiting_approval\"}" } } }] },
    ]);
  });

  it("groups consecutive tool results into one turn and sends errors as error", () => {
    const messages: ConversationMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "x", input: {} }, { id: "b", name: "y", input: {} }] },
      { role: "tool", tool_call_id: "a", name: "x", content: "ok" },
      { role: "tool", tool_call_id: "b", name: "y", content: "refused by the mandate", is_error: true },
    ];
    const out = toGeminiContents(messages);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "model", parts: [{ functionCall: { id: "a", name: "x", args: {} } }, { functionCall: { id: "b", name: "y", args: {} } }] });
    expect(out[1]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { id: "a", name: "x", response: { content: "ok" } } },
        { functionResponse: { id: "b", name: "y", response: { error: "refused by the mandate" } } },
      ],
    });
  });

  it("replays the model's own turn verbatim when it produced the call", () => {
    const kept: Content = { role: "model", parts: [{ functionCall: { id: "c1", name: "codespar_pay", args: {} }, thoughtSignature: "sig-123" }] };
    const out = toGeminiContents(
      [{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "codespar_pay", input: {} }] }],
      new Map([["c1", kept]]),
    );
    expect(out[0]).toBe(kept);
  });
});

describe("toGeminiDeclaration", () => {
  it("passes tools.json's JSON Schema through as parametersJsonSchema", () => {
    expect(toGeminiDeclaration(TOOL)).toEqual({ name: TOOL.name, description: TOOL.description, parametersJsonSchema: TOOL.input_schema });
  });
});

describe("GeminiRuntime", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses to start without a key", () => {
    expect(() => new GeminiRuntime({ apiKey: "" })).toThrow(/GEMINI_API_KEY is not set/);
  });

  it("sends the system prompt and tools, returns calls, and sends the signature back on the next turn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const answers = [
      { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "codespar_pay", args: { beneficiary: "Escola", amount: 120000 } }, thoughtSignature: "sig-xyz" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "Aguardando sua aprovação." }] } }] },
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = answers[Math.min(bodies.length - 1, answers.length - 1)];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });

    const runtime = new GeminiRuntime({ apiKey: "test-not-a-key", model: "gemini-test" });
    const first = await runtime.step({ system: "Você é o agente de contas.", messages: [{ role: "user", content: "pague a escola de outubro" }] }, [TOOL]);
    expect(Array.isArray(first)).toBe(true);
    const calls = first as Array<{ id: string; name: string; input: Record<string, unknown> }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("codespar_pay");
    expect(calls[0]?.input).toEqual({ beneficiary: "Escola", amount: 120000 });

    const sent = bodies[0] as { systemInstruction?: unknown; tools?: Array<{ functionDeclarations?: Array<{ name: string; parametersJsonSchema?: unknown }> }> };
    expect(JSON.stringify(sent.systemInstruction)).toContain("Você é o agente de contas.");
    expect(sent.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("codespar_pay");
    expect(sent.tools?.[0]?.functionDeclarations?.[0]?.parametersJsonSchema).toEqual(TOOL.input_schema);

    const id = calls[0]!.id;
    const second = await runtime.step(
      {
        system: "Você é o agente de contas.",
        messages: [
          { role: "user", content: "pague a escola de outubro" },
          { role: "assistant", content: "", tool_calls: calls },
          { role: "tool", tool_call_id: id, name: "codespar_pay", content: "{\"status\":\"awaiting_approval\"}" },
        ],
      },
      [TOOL],
    );
    expect(second).toEqual({ text: "Aguardando sua aprovação." });
    expect(JSON.stringify(bodies[1])).toContain("sig-xyz");
  });
});

describe("withRetry", () => {
  it("retries 429 and 503, then returns", async () => {
    const { withRetry } = await import("../src/providers/gemini.js");
    let n = 0;
    const out = await withRetry(async () => { n++; if (n < 3) throw Object.assign(new Error("busy"), { status: n === 1 ? 429 : 503 }); return "ok"; }, [1, 1, 1], async () => {});
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });
  it("does not retry a 400 and gives up after the last delay", async () => {
    const { withRetry } = await import("../src/providers/gemini.js");
    let n = 0;
    await expect(withRetry(async () => { n++; throw Object.assign(new Error("bad"), { status: 400 }); }, [1, 1], async () => {})).rejects.toThrow("bad");
    expect(n).toBe(1);
    let m = 0;
    await expect(withRetry(async () => { m++; throw Object.assign(new Error("busy"), { status: 429 }); }, [1, 1], async () => {})).rejects.toThrow("busy");
    expect(m).toBe(3);
  });
});
