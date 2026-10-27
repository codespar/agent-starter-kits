/**
 * The pull over the WhatsApp channel, on the offline fixture: a real process,
 * no key of any kind, the WHATSAPP_* and INICIADOR_* variables blanked so a
 * machine with credentials in its shell runs the same test as the CI.
 *
 * Needs the local Cloud API emulator (`npm run whatsapp:emulator`) and SKIPS
 * when it is not listening. What is asserted is the shape of the conversation:
 * the bank's link as its own message, the yes before it, the end-to-end id
 * after it, and no refusal.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const EMULATOR = process.env["WHATSAPP_SIM_URL"] ?? "http://127.0.0.1:4290";

const emulatorUp = await (async () => {
  try {
    return (await fetch(`${EMULATOR}/health`, { headers: { connection: "close" }, signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();
if (!emulatorUp) process.stderr.write(`[whatsapp] no emulator at ${EMULATOR}; the topup conversation is skipped. Start it with \`npm run whatsapp:emulator\`.\n`);

interface Line {
  direction: "in" | "out" | "status";
  kind: string;
  text?: string;
  refused?: { rule: string };
}

describe.skipIf(!emulatorUp)("the pull over WhatsApp", () => {
  it("asks for a yes, sends the bank's link as its own message, and closes with the end-to-end id", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "topup-wa-"));
    tempDirs.push(stateDir);
    const blank = Object.fromEntries(["INICIADOR_CLIENT_ID", "INICIADOR_CLIENT_SECRET", "INICIADOR_TEST_TAX_ID", "INICIADOR_CREDITOR_ID", "INICIADOR_TRIGGER_ID", "INICIADOR_PARTICIPANT_ID", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"].map((k) => [k, ""]));
    const result = spawnSync(
      process.execPath,
      [BIN, "start", "--channel", "whatsapp", "--conversation", "recarga", "--scripted", "--simulate-payer", "--mode", "mandate", "--transcript", "scenarios/happy-path.transcript.jsonl", "--json", "--now", "2026-10-27T14:00:00-03:00"],
      {
        cwd: AGENT_DIR,
        env: {
          ...process.env,
          ...blank,
          ANTHROPIC_API_KEY: "",
          GEMINI_API_KEY: "",
          CODESPAR_API_KEY: "",
          TOPUP_STATE_DIR: stateDir,
          TOPUP_RUNS_DIR: join(stateDir, "runs"),
          WHATSAPP_SIM_PHONE_NUMBER_ID: `9${String(Math.floor(Math.random() * 1e11)).padStart(11, "0")}`,
        },
        encoding: "utf8",
        timeout: 90_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { executions: Array<{ state: string; end_to_end_id: string | null }>; channel: { refused: unknown[]; log: string } };
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
    const e2e = payload.executions[0]!.end_to_end_id!;
    expect(e2e).toMatch(/^E\d{8}/);
    expect(payload.channel.refused).toEqual([]);

    const log = isAbsolute(payload.channel.log) ? payload.channel.log : join(AGENT_DIR, payload.channel.log);
    const out = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line).filter((l) => l.direction === "out");
    const link = out.findIndex((l) => l.kind === "instrument");
    expect(link).toBeGreaterThan(0);
    expect(out[link]!.text).toMatch(/^https:\/\//);
    // The yes was asked before the bank was; the outcome comes after the link, with the end-to-end id.
    expect(out.slice(0, link).some((l) => /sim ou não/.test(l.text ?? ""))).toBe(true);
    expect(out.slice(link + 1).map((l) => l.text ?? "").join("\n")).toContain(e2e);
    // The fixture's CPF never reaches the conversation (the channel's own rule refuses any bare document, and nothing was refused).
    expect(out.map((l) => l.text ?? "").join("\n")).not.toContain("00000000000");
  });
});
