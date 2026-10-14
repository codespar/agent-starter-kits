/**
 * The first five minutes tell one story. The READMEs send a newcomer to
 * codespar.dev/auth/signup for a sandbox key; the message for a missing key
 * and the `.env.example` files sent them to another address, and the four
 * agents that need a key shipped two different `.env.example` (an empty
 * ANTHROPIC_API_KEY in two, a placeholder in the others; the staging URL as a
 * commented line in two, as "set it in your shell" in another).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { testKeyMessage } from "../packages/agent-core/src/secrets.js";

const ROOT = resolve(import.meta.dirname, "..");
const SIGNUP = "https://codespar.dev/auth/signup";
const read = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");
const agents = readdirSync(join(ROOT, "agents"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
/** hello-agent reads and pays nothing: its file says it needs no key, so it names no place to get one. */
const withAKey = agents.filter((a) => a !== "hello-agent");

describe("where a sandbox key comes from", () => {
  it("the READMEs say the signup page", () => {
    expect(read("README.md")).toContain(SIGNUP);
  });

  it("the message for a missing key and for the placeholder says the same page", () => {
    expect(testKeyMessage("missing", "agents/bills-agent/.env")).toContain(`key from ${SIGNUP}.`);
    expect(testKeyMessage("placeholder", "agents/bills-agent/.env")).toContain(`key from ${SIGNUP}.`);
  });

  it.each(withAKey)("%s/.env.example says the same page", (agent) => {
    expect(read("agents", agent, ".env.example")).toContain(`# Test key from ${SIGNUP} (starts with csk_test_). A live key is refused.`);
  });

  it("nothing a newcomer reads to get a test key names another address", () => {
    const files = [...agents.map((a) => join("agents", a, ".env.example")), join(".devcontainer", "devcontainer.json"), join("packages", "agent-core", "src", "secrets.ts")];
    for (const file of files) expect([file, /dashboard\.codespar\.dev/.test(read(file))]).toEqual([file, false]);
  });
});

describe("the .env.example of every agent that needs a key", () => {
  const settings = (agent: string) => read("agents", agent, ".env.example").split("\n").filter((line) => /^#? ?(CODESPAR_API_KEY|ANTHROPIC_API_KEY|CODESPAR_API_URL)=/.test(line));

  it.each(withAKey)("%s: the same three lines, an empty model key and the staging URL commented out", (agent) => {
    expect(settings(agent)).toEqual(["CODESPAR_API_KEY=csk_test_your_key_here", "ANTHROPIC_API_KEY=", "# CODESPAR_API_URL=https://api.staging.codespar.dev"]);
  });

  it.each(withAKey)("%s: says where the file goes", (agent) => {
    expect(read("agents", agent, ".env.example").split("\n")[0]).toContain(`# Copy to agents/${agent}/.env.`);
  });

  it("no example tells a person to set the staging URL somewhere else", () => {
    for (const agent of agents) expect([agent, /in your shell/.test(read("agents", agent, ".env.example"))]).toEqual([agent, false]);
  });
});
