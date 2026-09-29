/**
 * #64, asked of every agent this repository ships: each kit's string table
 * has every key in both locales, `npm run check` fails when one is missing,
 * and a WhatsApp registry declares every template in the language of every
 * locale.
 *
 * Here and not inside a package because it reads `agents/*`, and `codespar
 * init` copies the packages into a template with ONE agent.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES, checkAgent } from "@codespar/agent-core";
import { checkStrings, defaultKit, loadAgent, type Agent } from "@codespar/agent-runtime";

const AGENTS = resolve(import.meta.dirname, "../agents");
const names = readdirSync(AGENTS).sort();
const agents: Array<[string, Agent]> = await Promise.all(names.map(async (n) => [n, await loadAgent(join(AGENTS, n))] as [string, Agent]));

/** Calls a table entry with placeholder arguments of the arity it declares, so a function key is read as the text it prints. */
function render(value: unknown): string {
  if (typeof value === "string") return value;
  const fn = value as (...args: unknown[]) => string;
  return fn(...Array.from({ length: fn.length }, (_, i) => (i % 2 === 0 ? "X" : 2)));
}

describe("every agent's strings exist in every locale", () => {
  it.each(agents)("%s: npm run check finds no gap in its table or the shared one", (_name, agent) => {
    expect(checkStrings(agent.kit)).toEqual([]);
  });

  it.each(agents)("%s: every key prints text in both locales, never `undefined`", (_name, agent) => {
    const keys = Object.keys(agent.kit.strings["pt-BR"]).sort();
    expect(Object.keys(agent.kit.strings.en).sort()).toEqual(keys);
    for (const locale of LOCALES) {
      for (const key of keys) {
        const text = render((agent.kit.strings[locale] as unknown as Record<string, unknown>)[key]);
        expect(text.trim(), `${locale}.${key}`).not.toBe("");
        expect(text, `${locale}.${key}`).not.toContain("undefined");
      }
    }
  });

  it.each(agents)("%s: asks its approval question with the answers its locale reads", (_name, agent) => {
    expect(agent.kit.strings["pt-BR"].approveQuestion).toMatch(/\[s\/N\] $/);
    expect(agent.kit.strings.en.approveQuestion).toMatch(/\[y\/N\] $/);
  });

  it("a kit whose English entry lacks a key fails the check, naming the key", () => {
    const broken = { strings: { "pt-BR": defaultKit.strings["pt-BR"], en: { ...defaultKit.strings.en, approveQuestion: undefined } } } as unknown as Parameters<typeof checkStrings>[0];
    const findings = checkStrings(broken);
    expect(findings.map((f) => f.code)).toEqual(["strings_incomplete"]);
    expect(findings[0]!.message).toBe("kit.strings.approveQuestion is missing in en");
  });
});

describe("a WhatsApp registry declares each template in the language of each locale", () => {
  const copy = (agent: string) => {
    const dir = mkdtempSync(join(tmpdir(), "wa-locale-check-"));
    cpSync(join(AGENTS, agent), dir, { recursive: true, filter: (src) => !/node_modules|\/runs|\.codespar/.test(src) });
    return dir;
  };
  const registry = (dir: string) => join(dir, "channels/whatsapp/templates.json");
  const edit = (dir: string, fn: (templates: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) => {
    const doc = JSON.parse(readFileSync(registry(dir), "utf8")) as { templates: Array<Record<string, unknown>> };
    doc.templates = fn(doc.templates);
    writeFileSync(registry(dir), JSON.stringify(doc));
  };
  const said = (dir: string) =>
    checkAgent(dir)
      .findings.filter((f) => f.code === "channels_templates_locale")
      .map((f) => f.message)
      .join("\n");

  it.each(["collections-agent", "checkout-agent"])("%s ships every template in pt_BR and en_US, and passes", (agent) => {
    expect(said(join(AGENTS, agent))).toBe("");
    const templates = (JSON.parse(readFileSync(registry(join(AGENTS, agent)), "utf8")) as { templates: Array<{ name: string; language: string }> }).templates;
    const pairs = new Set(templates.map((t) => `${t.name}/${t.language}`));
    for (const name of new Set(templates.map((t) => t.name))) for (const language of ["pt_BR", "en_US"]) expect(pairs.has(`${name}/${language}`), `${name}/${language}`).toBe(true);
  });

  it("a template with no en_US copy fails: an English conversation could not send it", () => {
    const dir = copy("collections-agent");
    edit(dir, (ts) => ts.filter((t) => !(t["name"] === "acordo_quitado" && t["language"] === "en_US")));
    expect(said(dir)).toContain("acordo_quitado has no en_US copy");
  });

  it("a copy in a language no locale sends fails", () => {
    const dir = copy("collections-agent");
    edit(dir, (ts) => [...ts, { ...ts[0]!, language: "es_MX" }]);
    expect(said(dir)).toContain("declared in es_MX, which no locale sends");
  });

  it("a translation that drops a button fails: the copies must offer the same taps", () => {
    const dir = copy("collections-agent");
    edit(dir, (ts) => ts.map((t) => (t["name"] === "acordo_cobranca_vencida" && t["language"] === "en_US" ? { ...t, buttons: (t["buttons"] as unknown[]).slice(0, 1) } : t)));
    expect(said(dir)).toContain("the copies of acordo_cobranca_vencida differ");
  });
});
