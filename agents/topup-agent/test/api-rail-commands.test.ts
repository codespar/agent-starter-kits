/**
 * `start --rail api` and then a bare `poll` look at the same bank, with no
 * CodeSpar key anywhere. The poll used to resolve its rail from
 * CODESPAR_API_KEY alone, fall back to the offline fixture, and answer an
 * authorization the fixture never saw. A fake Iniciador on 127.0.0.1 (the
 * client's only allowed host besides the sandbox) answers both processes.
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlLWZha2U";

const tempDirs: string[] = [];
let server: Server;
let base = "";
/** What the fake bank says about the authorization the next time it is read; "503" answers a server error instead. */
let authStatus = "AWAITING_AUTHORISATION";
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/^\/v1/, "");
    seen.push(`${req.method} ${path}`);
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    req.resume();
    req.on("end", () => {
      if (path === "/sweeping/auth") return reply(201, { accessToken: TOKEN });
      if (req.headers["authorization"] !== `Bearer ${TOKEN}`) return reply(401, { message: "unauthorized" });
      if (req.method === "POST" && path === "/sweeping/authorizations") {
        return reply(201, { authorizationId: "urn:Iniciador:auth-cli", status: "AWAITING_AUTHORISATION", authUrl: "https://bank.example/consent?request_uri=urn:cli" });
      }
      if (req.method === "GET" && path === "/sweeping/authorizations/urn%3AIniciador%3Aauth-cli") {
        if (authStatus === "503") return reply(503, { message: "service unavailable" });
        return reply(200, { authorizationId: "urn:Iniciador:auth-cli", status: authStatus });
      }
      if (req.method === "POST" && path === "/sweeping/authorizations/urn%3AIniciador%3Aauth-cli/payments") {
        return reply(201, { id: "pay-cli", status: "CONSENT_AUTHORIZED", endToEndId: "E44471172202610271200abcdef12345" });
      }
      if (req.method === "GET" && path === "/sweeping/authorizations/urn%3AIniciador%3Aauth-cli/payments/pay-cli/status") {
        return reply(200, { id: "pay-cli", status: "PAYMENT_COMPLETED", endToEndId: "E44471172202610271200abcdef12345" });
      }
      return reply(404, { message: "not found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Asynchronous on purpose: the fake bank runs in this process, and a synchronous spawn would stop it answering. */
function run(command: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [BIN, command, ...args], { cwd: AGENT_DIR, env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      done({ code, stdout, stderr });
    });
  });
}

const EMULATOR = process.env["WHATSAPP_SIM_URL"] ?? "http://127.0.0.1:4290";
const emulatorUp = await (async () => {
  try {
    return (await fetch(`${EMULATOR}/health`, { headers: { connection: "close" }, signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();

/** A scratch state, the fake bank's address and its fake credentials; no CodeSpar key, no model key. */
function scratch(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "topup-api-cli-"));
  tempDirs.push(dir);
  seen.length = 0;
  authStatus = "AWAITING_AUTHORISATION";
  return {
    CODESPAR_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    TOPUP_STATE_DIR: join(dir, "state"),
    TOPUP_RUNS_DIR: join(dir, "runs"),
    INICIADOR_BASE_URL: base,
    INICIADOR_CLIENT_ID: "fake-client-id",
    INICIADOR_CLIENT_SECRET: "fake-client-secret",
    INICIADOR_TEST_TAX_ID: "12345678909",
    INICIADOR_CREDITOR_ID: "creditor-fake",
    INICIADOR_TRIGGER_ID: "trigger-fake",
    INICIADOR_PARTICIPANT_ID: "participant-fake",
  };
}

const payments = () => seen.filter((r) => r.startsWith("POST") && r.endsWith("/payments")).length;

describe("the api rail of an agent whose live rail is not the CodeSpar API", () => {
  it("start --rail api, then a poll with no --rail and no CodeSpar key, reads the same bank and settles once", async () => {
    const env = scratch();
    const started = await run("start", ["--rail", "api", "--input", "sim, pode puxar R$ 1", "--provider", "replay", "--transcript", "test/fixtures/pull-now.transcript.jsonl", "--mode", "mandate", "--wait", "0", "--json"], env);
    // 3: the run ended with the pull still open (the person has not approved at the bank yet), which is what `poll` is for.
    expect(started.code, started.stderr).toBe(3);
    const s = JSON.parse(started.stdout.trim()) as { executions: Array<{ state: string }> };
    expect(s.executions.map((e) => e.state)).toEqual(["executing"]);
    expect(seen.filter((r) => r === "POST /sweeping/authorizations")).toHaveLength(1);

    authStatus = "AUTHORISED";
    const polled = await run("poll", ["--json"], env);
    expect(polled.code, polled.stderr).toBe(0);
    const p = JSON.parse(polled.stdout.trim()) as { polled: Array<{ state: string }> };
    expect(p.polled.map((e) => e.state)).toEqual(["settled"]);
    // The poll read the bank's authorization; one payment request in all.
    expect(seen.filter((r) => r === "GET /sweeping/authorizations/urn%3AIniciador%3Aauth-cli").length).toBeGreaterThanOrEqual(1);
    expect(payments()).toBe(1);
  });

  it("a poll whose look got a 503 leaves the pull in the queue, and the next poll's clean look settles it", async () => {
    const env = scratch();
    expect((await run("start", ["--rail", "api", "--input", "sim, pode puxar R$ 1", "--provider", "replay", "--transcript", "test/fixtures/pull-now.transcript.jsonl", "--mode", "mandate", "--wait", "0", "--json"], env)).code).toBe(3);

    authStatus = "503";
    const blip = await run("poll", ["--json", "--wait", "0"], env);
    expect(JSON.parse(blip.stdout.trim()).polled).toEqual([expect.objectContaining({ state: "executing", reason: "rail_uncertain" })]);

    authStatus = "AUTHORISED";
    const clean = await run("poll", ["--json"], env);
    expect(clean.code, clean.stderr).toBe(0);
    expect(JSON.parse(clean.stdout.trim()).polled).toEqual([expect.objectContaining({ state: "settled" })]);
    expect(payments()).toBe(1);
  });

  it.skipIf(!emulatorUp)("the same over WhatsApp: the conversation's poll keeps looking after a 503 and tells the person once it settles", async () => {
    const env = { ...scratch(), WHATSAPP_SIM_PHONE_NUMBER_ID: `9${String(Math.floor(Math.random() * 1e11)).padStart(11, "0")}` };
    const started = await run("start", ["--channel", "whatsapp", "--conversation", "recarga", "--scripted", "--rail", "api", "--provider", "replay", "--transcript", "scenarios/happy-path.transcript.jsonl", "--mode", "mandate", "--wait", "0", "--json"], env);
    expect(JSON.parse(started.stdout.trim()).executions.map((e: { state: string }) => e.state), started.stderr).toEqual(["executing"]);

    authStatus = "503";
    const blip = await run("poll", ["--channel", "whatsapp", "--conversation", "recarga", "--json", "--wait", "0"], env);
    expect(JSON.stringify(JSON.parse(blip.stdout.trim())), blip.stderr).toContain("rail_uncertain");

    authStatus = "AUTHORISED";
    const clean = await run("poll", ["--channel", "whatsapp", "--conversation", "recarga", "--json"], env);
    expect(clean.code, clean.stderr).toBe(0);
    expect(JSON.stringify(JSON.parse(clean.stdout.trim()))).toContain('"state":"settled"');
    expect(payments()).toBe(1);
  });
});
