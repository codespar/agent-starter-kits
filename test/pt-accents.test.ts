/**
 * The guard against Portuguese that lost its accents (#64). The tree it ships
 * with is clean, and a planted word makes it fail: a guard nobody has seen
 * refuse anything is not a guard.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { accented, fix, scan } from "../scripts/pt-accents.mjs";

type Finding = { file: string; line: number; word: string; suggestion: string };
const ROOT = resolve(import.meta.dirname, "..");

/** A tree with no git, so the scanner walks it; `files` is path -> content. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pt-accents-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("unaccented Portuguese in what a person reads", () => {
  it("the shipped tree has none", () => {
    expect((scan(ROOT) as Finding[]).map((f) => `${f.file}:${f.line} ${f.word}`)).toEqual([]);
  });

  it("fails on a planted word in a kit's string, a template body, a README and a recorded reply", () => {
    const dir = tree({
      "agents/x/src/strings.ts": 'export const s = { unreadable: "  nao entendi; responda todas" };\n',
      "agents/x/channels/whatsapp/templates.json": '{ "body": "Oi! A cobranca do {{1}} venceu." }\n',
      "agents/x/README.md": "The question reads `Aprovar a execucao?`.\n",
      "agents/x/scenarios/a.transcript.jsonl": '{"kind":"assistant_step","reply":"Voce ja pagou."}\n',
    });
    const found = (scan(dir) as Finding[]).map((f) => `${f.file}:${f.word}->${f.suggestion}`);
    expect(found).toEqual([
      "agents/x/README.md:execucao->execução",
      "agents/x/channels/whatsapp/templates.json:cobranca->cobrança",
      "agents/x/scenarios/a.transcript.jsonl:Voce->Você",
      "agents/x/scenarios/a.transcript.jsonl:ja->já",
      "agents/x/src/strings.ts:nao->não",
    ]);
  });

  it("does not read names, what a person typed, test code, or an allowed machine value", () => {
    const dir = tree({
      // Joined to an identifier: a reply id, a SKU, a timezone, a template name.
      "agents/x/channels/whatsapp/templates.json": '{ "id": "agora_nao", "sku": "avaliacao-inicial", "tz": "America/Sao_Paulo", "name": "acordo_cobranca_vencida" }\n',
      // A button's intent is the turn a tap stands for, recorded as a person types it (#62), and compared.
      "agents/y/channels/whatsapp/templates.json": '{ "buttons": [{ "id": "agora_nao", "intent": "agora nao quero uma nova cobranca" }] }\n',
      // Typed by the person: a scenario input, a conversation turn, an --input argument.
      "agents/x/scenarios/a.json": '{ "turns": [{ "input": "nao sei, voce decide" }] }\n',
      "agents/x/channels/whatsapp/c.json": '{ "turns": [{ "text": "ja paguei" }] }\n',
      "agents/x/README.md": 'npm start -- --input "paga a funcionaria do mes"\n',
      // A payee alias the mandate names and the code compares.
      "agents/x/tools.json": '{ "payees": "escola, mercado, funcionaria, contas" }\n',
      // Test code is not read by a person.
      "agents/x/test/a.test.ts": 'expect(x).toBe("nao");\n',
      // The parser reads the unaccented answer a person types.
      "packages/agent-runtime/src/terminal.ts": 'if (text === "nao") return all;\n',
    });
    expect(scan(dir)).toEqual([]);
  });

  it("an allowed word is allowed only in the file it is allowed in", () => {
    const dir = tree({ "packages/agent-runtime/src/other.ts": 'if (text === "nao") return all;\n' });
    expect((scan(dir) as Finding[]).map((f) => f.word)).toEqual(["nao"]);
  });

  it("fix writes the accent in the case the word was written in, and leaves what scan skips", async () => {
    expect([accented("nao"), accented("Nao"), accented("NAO"), accented("Cobranca")]).toEqual(["não", "Não", "NÃO", "Cobrança"]);
    const dir = tree({ "agents/x/src/strings.ts": 'const a = "Nao ha cobranca"; const id = "agora_nao";\n', "agents/x/scenarios/a.json": '{ "input": "nao" }\n' });
    fix(dir);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dir, "agents/x/src/strings.ts"), "utf8")).toBe('const a = "Não ha cobrança"; const id = "agora_nao";\n');
    expect(readFileSync(join(dir, "agents/x/scenarios/a.json"), "utf8")).toBe('{ "input": "nao" }\n');
    expect(scan(dir)).toEqual([]);
  });
});
