/**
 * A recorded reply is replayed whatever the run does with what it proposed:
 * the same `happy-path` transcript answers a payment that settled, one a
 * person denied, one left awaiting approval and one the rail refused. It was
 * written when the payment settled and said "o resultado e o recibo estão no
 * terminal", which is false in the other three.
 *
 * The line that counts what happened is the engine's (`outcome.ts`), printed
 * under the reply. A recording cannot know it, so it cites no receipt: it
 * says where the result is. This reads every transcript a replay can play:
 * the scenario packs, the adversarial cases and the test fixtures.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "runs", ".codespar"]);
// The kit's own word for what a settled payment returns. "Comprovante" is the payer's proof of payment, which the checkout agent tells a customer NOT to send.
const CITES_A_RECEIPT = /recibo|receipt/i;

function transcripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return transcripts(path);
    return entry.name.endsWith(".transcript.jsonl") ? [path] : [];
  });
}

function replies(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { reply?: unknown }).reply)
    .filter((reply): reply is string => typeof reply === "string");
}

describe("a recorded reply cites no receipt", () => {
  const files = transcripts(join(ROOT, "agents"));

  it("reads the transcripts of every agent", () => {
    const agents = readdirSync(join(ROOT, "agents"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const agent of agents) expect([agent, files.some((f) => relative(join(ROOT, "agents"), f).startsWith(agent))]).toEqual([agent, true]);
  });

  it("no reply of a scenario, an adversarial case or a fixture promises one", () => {
    const found = files.flatMap((file) => replies(file).filter((reply) => CITES_A_RECEIPT.test(reply)).map((reply) => `${relative(ROOT, file)}: ${reply}`));
    expect(found).toEqual([]);
  });

  it("the rule sees the sentences that were recorded before it", () => {
    expect(CITES_A_RECEIPT.test("Propus o pagamento da Escola Aurora. O resultado e o recibo estão no terminal acima.")).toBe(true);
    expect(CITES_A_RECEIPT.test("Cada uma virou uma execução própria, com o recibo no terminal.")).toBe(true);
    expect(CITES_A_RECEIPT.test("Propus o pagamento da Escola Aurora. O resultado está no terminal.")).toBe(false);
  });
});
