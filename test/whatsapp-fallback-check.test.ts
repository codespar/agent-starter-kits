/**
 * §46's third gap, as `npm run check` answers it: the WhatsApp template
 * registry declares a fallback for an outcome the kit has no copy of, and a
 * conversation taps only a reply some declared template offers. Asked of the
 * agents this repository ships — the collections-agent as the fixture, both
 * WhatsApp agents as the "they pass" case.
 *
 * Moved out of `packages/agent-runtime/test/whatsapp-status-replies.test.ts`,
 * where it was section 3, because it reads `agents/collections-agent` and
 * `agents/checkout-agent`: `codespar init` copies the runtime package into
 * every template and copies ONE agent, so from inside the package it failed
 * the `npm test` of every scaffold that is not both of them. The root `test/`
 * ships nowhere; here it runs unconditionally and fails when the rule does.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAgent } from "@codespar/agent-core";

describe("an outcome with no template of its own: the registry declares a fallback, and check requires one", () => {
  const COLLECTIONS = resolve(import.meta.dirname, "../agents/collections-agent");
  const copy = () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-fallback-check-"));
    cpSync(COLLECTIONS, dir, { recursive: true, filter: (src) => !/node_modules|\/runs|\.codespar/.test(src) });
    return dir;
  };
  const codes = (dir: string) => checkAgent(dir).findings.filter((f) => f.level === "error").map((f) => f.code);
  /** What the fallback rule said, so a case is caught by the clause it is about and not by a neighbour that also fires. */
  const fallbackSaid = (dir: string) =>
    checkAgent(dir)
      .findings.filter((f) => f.code === "channels_templates_fallback")
      .map((f) => f.message)
      .join("\n");
  const registry = (dir: string) => join(dir, "channels/whatsapp/templates.json");
  const edit = (dir: string, fn: (templates: Array<Record<string, unknown>>) => void) => {
    const doc = JSON.parse(readFileSync(registry(dir), "utf8")) as { templates: Array<Record<string, unknown>> };
    fn(doc.templates);
    writeFileSync(registry(dir), JSON.stringify(doc));
  };

  it("the shipped agents pass", () => {
    expect(codes(COLLECTIONS)).toEqual([]);
    expect(codes(resolve(COLLECTIONS, "../checkout-agent"))).toEqual([]);
  });

  it("refuses a WhatsApp agent with no fallback, with two, and with one that takes variables", () => {
    const none = copy();
    edit(none, (t) => t.forEach((x) => delete x["fallback"]));
    expect(codes(none)).toContain("channels_templates_fallback");
    const two = copy();
    edit(two, (t) => t.forEach((x) => (x["fallback"] = true)));
    expect(codes(two)).toContain("channels_templates_fallback");
    expect(fallbackSaid(two)).toMatch(/declares [2-9]\d* fallback template\(s\); it must declare exactly one/);
    const variables = copy();
    edit(variables, (t) => {
      const fallback = t.find((x) => x["fallback"])!;
      fallback["body"] = "Oi {{1}}, temos novidade.";
    });
    expect(codes(variables)).toContain("channels_templates_fallback");
  });

  it("refuses a conversation that taps a reply no template offers, and two templates offering the same id", () => {
    const script = copy();
    const path = join(script, "channels/whatsapp/acordo-1042.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as { turns: unknown[] };
    doc.turns.push({ reply: { id: "pagar_tudo" } });
    writeFileSync(path, JSON.stringify(doc));
    expect(codes(script)).toContain("channels_script_invalid");
    const dup = copy();
    edit(dup, (t) => {
      t[0]!["buttons"] = [{ id: "emitir_nova", title: "Outra", intent: "outra coisa" }];
    });
    expect(codes(dup)).toContain("channels_templates_invalid");
  });
});
