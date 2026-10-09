/**
 * With no model key, `npm start -- --input "<text>"` replays the recorded
 * scenario whose first turn is that text. Two scenarios that open with the
 * same sentence leave one of them unreachable that way: the lookup takes the
 * first. checkout-agent had three under one sentence and bills-agent two.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const agents = readdirSync(join(ROOT, "agents"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

function firstTurns(agent: string): Map<string, string[]> {
  const dir = join(ROOT, "agents", agent, "scenarios");
  const by = new Map<string, string[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const scenario = JSON.parse(readFileSync(join(dir, file), "utf8")) as { name: string; turns: Array<{ input: string }> };
    const first = scenario.turns[0]!.input;
    by.set(first, [...(by.get(first) ?? []), scenario.name]);
  }
  return by;
}

describe("every scenario is reachable by its first turn", () => {
  it.each(agents)("%s: no two scenarios open with the same sentence", (agent) => {
    const shared = [...firstTurns(agent)].filter(([, names]) => names.length > 1).map(([text, names]) => `"${text}": ${names.join(", ")}`);
    expect(shared).toEqual([]);
  });
});
