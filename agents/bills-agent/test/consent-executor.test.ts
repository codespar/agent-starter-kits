/**
 * ent#1983: the consent names who executes the payments before the titular
 * signs. The quickstart asks for the CodeSpar simulator, the integrated proof
 * (the bank-integration example) for the provider's sandbox; the label the API
 * confirms is shown before the question and after the signature; a provider
 * sandbox that is not ready is said with what is missing and the next steps,
 * and never turned into the simulator; a Live key and an API that does not
 * confirm the executor stop the consent with nothing stored.
 *
 * Every call goes through the real SDK client against a local server, so the
 * error codes and `details` are read the way the SDK hands them over.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCodeSparClient, loadMandate, type Mandate } from "@codespar/agent-core";
import { ConsentRefusedError, consentExecutorFor, runEmbeddedConsent } from "../src/modules/embedded-consent.js";
import { INTEGRATED_CAP_MINOR, integratedExample } from "../src/modules/integrated-proof.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const PROOF = { consumerId: "cst_prova_test", receiverKey: "00000000-0000-4000-8000-000000000001" };
const CELCOIN_FS = "fs_celcoin_cst_prova_test";
const SIM_LABEL = "Simulado pela CodeSpar";
const SANDBOX_LABEL = "Integrado (sandbox Celcoin)";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Answer {
  status: number;
  body: unknown;
}
type Route = (body: Record<string, unknown>) => Answer;

let server: Server;
let baseUrl: string;
let routes: Record<string, Route> = {};
let calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ method: req.method ?? "", path, body });
      const route = routes[`${req.method} ${path}`];
      const answer = route ? route(body) : { status: 404, body: { error: { code: "not_found", message: `no route ${req.method} ${path}` } } };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
});

beforeEach(() => {
  calls = [];
  routes = {};
});

const error = (status: number, code: string, message: string, details?: unknown): Answer => ({ status, body: { error: { code, message, ...(details ? { details } : {}) }, request_id: null } });

/** What the API of ent#1983 answers for a consent opened with `executor`. */
function initAnswer(executor: string | null, label: string | null): Route {
  return () => ({
    status: 201,
    body: { token: "tok_exec", expires_at: "2026-11-09T18:30:00.000Z", surface: "partner", consent_url: "https://codespar.dev/consent/tok_exec", ...(executor === null ? {} : { executor, executor_label: label }) },
  });
}

function submitAnswer(example: Mandate, executor: string | null, label: string | null, extra: Record<string, unknown> = {}, fundingSource = "cfs_sim"): Route {
  return (body) => ({
    status: 201,
    body: {
      mandate_id: "cm_exec",
      signature: "0".repeat(64),
      mandate: {
        consumer_id: body["consumer_id"],
        funding_source_id: fundingSource,
        agent_id: example.agent_id,
        purpose: example.purpose,
        currency: "BRL",
        cap_minor: example.cap_minor,
        per_tx_cap_minor: example.per_tx_cap_minor,
        ...(example.periodic_cap ? { periodic_cap: example.periodic_cap } : {}),
        merchant_pin_kind: "pix-key",
        merchant_allowlist: example.beneficiaries.map((b) => b.payee),
        expires_at: 1821312000,
      },
      executor,
      executor_label: label,
      ...extra,
    },
  });
}

const fundOk: Route = () => ({ status: 201, body: { amount_minor: 600000, account: "acc_test", deposit_id: "dep_test" } });
const celcoinSources: Route = () => ({ status: 200, body: { funding_sources: [{ id: CELCOIN_FS, consumer_id: PROOF.consumerId, rail: "pix-celcoin", status: "active" }], unattributed_count: 0 } });

const NOT_READY_DETAILS = {
  missing: ["sandbox_account_not_bound", "payments_capability_inactive"],
  next_steps: [
    "the project has no sandbox account bound yet: the platform prepares it for an eligible Test project; its state is on the dashboard's Sandbox page",
    "the project's `payments` capability is not active: an owner or admin requests it on the dashboard (project access)",
  ],
  alternative: { executor: "codespar_simulator" },
};

async function consent(options: { integrated?: boolean; locale?: "pt-BR" | "en" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bills-consent-executor-"));
  tempDirs.push(dir);
  const mandatePath = join(dir, ".codespar", "mandate.json");
  const said: string[] = [];
  let saidBeforeQuestion: string[] | null = null;
  const base = loadMandate(join(AGENT_DIR, "mandate.example.json"));
  const example = options.integrated ? integratedExample(base, PROOF) : base;
  const api = createCodeSparClient({ apiKey: "csk_test_unit_0000", baseUrl, timeoutMs: 5_000 });
  const run = runEmbeddedConsent({
    api,
    example,
    mandatePath,
    say: (l) => said.push(l),
    confirm: async () => {
      saidBeforeQuestion = [...said];
      return true;
    },
    now: () => new Date("2026-11-09T18:00:00.000Z"),
    ...(options.integrated ? { integrated: PROOF } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
  });
  return { run, said, mandatePath, example, before: () => saidBeforeQuestion };
}

const posted = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("the quickstart asks for the CodeSpar simulator, explicitly", () => {
  it("init carries executor codespar_simulator on a BRL Pix intent with no slots; the submit goes on pix-consent", async () => {
    const example = loadMandate(join(AGENT_DIR, "mandate.example.json"));
    routes["POST /v1/consents/init"] = initAnswer("codespar_simulator", SIM_LABEL);
    routes["POST /v1/consents/tok_exec/submit"] = submitAnswer(example, "codespar_simulator", SIM_LABEL);
    routes["POST /v1/test/fund"] = fundOk;
    const c = await consent();
    const mandate = await c.run;

    const [init] = posted("/v1/consents/init");
    expect(init!.body["executor"]).toBe("codespar_simulator");
    expect(init!.body["surface"]).toBe("partner");
    expect((init!.body["intent"] as Record<string, unknown>)["currency"]).toBe("BRL");
    expect(init!.body["intent"]).not.toHaveProperty("slots");
    expect(posted("/v1/consents/tok_exec/submit")[0]!.body["rail"]).toBe("pix-consent");
    expect(mandate.id).toBe("cm_exec");
    expect(existsSync(c.mandatePath)).toBe(true);
    expect(consentExecutorFor({})).toBe("codespar_simulator");
  });

  it("the person reads the executor before the question, and again after the signature", async () => {
    const example = loadMandate(join(AGENT_DIR, "mandate.example.json"));
    routes["POST /v1/consents/init"] = initAnswer("codespar_simulator", SIM_LABEL);
    routes["POST /v1/consents/tok_exec/submit"] = submitAnswer(example, "codespar_simulator", SIM_LABEL);
    routes["POST /v1/test/fund"] = fundOk;
    const c = await consent();
    await c.run;
    const before = c.before()!.join("\n");
    expect(before).toContain(`executor: ${SIM_LABEL} · sem dinheiro real (codespar_simulator): sem KYC, sem conta bancária, nenhum provedor chamado`);
    const after = c.said.slice(c.before()!.length).join("\n");
    expect(after).toContain(`Executor do mandato: ${SIM_LABEL} · sem dinheiro real.`);
  });

  it("in English too", async () => {
    const example = loadMandate(join(AGENT_DIR, "mandate.example.json"));
    routes["POST /v1/consents/init"] = initAnswer("codespar_simulator", SIM_LABEL);
    routes["POST /v1/consents/tok_exec/submit"] = submitAnswer(example, "codespar_simulator", SIM_LABEL);
    routes["POST /v1/test/fund"] = fundOk;
    const c = await consent({ locale: "en" });
    await c.run;
    expect(c.before()!.join("\n")).toContain(`executor: ${SIM_LABEL} · sem dinheiro real (codespar_simulator): no KYC, no bank account, no provider called`);
    expect(c.said.join("\n")).toContain(`Mandate executor: ${SIM_LABEL} · sem dinheiro real.`);
  });
});

describe("an API that does not confirm the executor: nothing is signed", () => {
  it("an init answer with no executor (an API before ent#1983) stops before the question; no submit, no file", async () => {
    routes["POST /v1/consents/init"] = initAnswer(null, null);
    const c = await consent();
    await expect(c.run).rejects.toMatchObject({ name: "ConsentRefusedError", code: "executor_not_confirmed" });
    expect(c.before()).toBeNull();
    expect(posted("/v1/consents/tok_exec/submit")).toHaveLength(0);
    expect(existsSync(c.mandatePath)).toBe(false);
    expect(c.said.join("\n")).toMatch(/A API não confirmou o executor pedido \(codespar_simulator; respondeu nenhum\)/);
  });

  it("a signed mandate on another executor than the one confirmed is not stored", async () => {
    const example = loadMandate(join(AGENT_DIR, "mandate.example.json"));
    routes["POST /v1/consents/init"] = initAnswer("codespar_simulator", SIM_LABEL);
    routes["POST /v1/consents/tok_exec/submit"] = submitAnswer(example, null, null);
    const c = await consent();
    await expect(c.run).rejects.toBeInstanceOf(ConsentRefusedError);
    expect(existsSync(c.mandatePath)).toBe(false);
    expect(posted("/v1/test/fund")).toHaveLength(0);
    expect(c.said.join("\n")).toContain("A API assinou o mandato cm_exec com executor nenhum, não com codespar_simulator");
  });

  it("executor_guidance on the submit answer is said, in the API's words", async () => {
    const example = loadMandate(join(AGENT_DIR, "mandate.example.json"));
    routes["POST /v1/consents/init"] = initAnswer("codespar_simulator", SIM_LABEL);
    routes["POST /v1/consents/tok_exec/submit"] = submitAnswer(example, null, null, {
      executor_guidance: { code: "funding_source_executor_required", message: "signed over a bare pix-consent source", next: { action: "reconsent_with_executor" } },
    });
    const c = await consent();
    await expect(c.run).rejects.toBeInstanceOf(ConsentRefusedError);
    expect(c.said.join("\n")).toContain("Aviso da API (funding_source_executor_required): signed over a bare pix-consent source");
  });
});

describe("a Live key", () => {
  it("simulation_refused_live is said with what it means, and nothing is created", async () => {
    routes["POST /v1/consents/init"] = () => error(422, "simulation_refused_live", "a Live project never simulates a payment: `codespar_simulator` is available only in a Test project. Nothing was created");
    const c = await consent();
    await expect(c.run).rejects.toMatchObject({ code: "simulation_refused_live" });
    const text = c.said.join("\n");
    expect(text).toContain("simulation_refused_live: a Live project never simulates a payment");
    expect(text).toMatch(/Live nunca simula/);
    expect(existsSync(c.mandatePath)).toBe(false);
    expect(posted("/v1/consents/tok_exec/submit")).toHaveLength(0);
  });
});

describe("the bank-integration example (integrated proof) asks for the provider's sandbox", () => {
  it("init carries executor provider_sandbox; the label is the provider's; the mandate stays on the Celcoin source (an API before the public rename)", async () => {
    const example = integratedExample(loadMandate(join(AGENT_DIR, "mandate.example.json")), PROOF);
    routes["GET /v1/consumers/funding-sources"] = celcoinSources;
    routes["POST /v1/consents/init"] = initAnswer("celcoin_sandbox", SANDBOX_LABEL);
    routes["POST /v1/consents/tok_exec/submit"] = submitAnswer(example, "celcoin_sandbox", SANDBOX_LABEL, {}, CELCOIN_FS);
    const c = await consent({ integrated: true });
    const mandate = await c.run;
    expect(posted("/v1/consents/init")[0]!.body["executor"]).toBe("provider_sandbox");
    expect(posted("/v1/consents/tok_exec/submit")[0]!.body["rail"]).toBe("pix-consent");
    expect(c.before()!.join("\n")).toContain(`executor: ${SANDBOX_LABEL} · sem dinheiro real (celcoin_sandbox, provedor celcoin, resolvido pela CodeSpar)`);
    expect(mandate.canonical?.["funding_source_id"]).toBe(CELCOIN_FS);
    expect(mandate.cap_minor).toBe(INTEGRATED_CAP_MINOR);
    expect(posted("/v1/test/fund")).toHaveLength(0);
    expect(consentExecutorFor({ integrated: PROOF })).toBe("provider_sandbox");
  });

  it("ent#1983 public names: provider_sandbox with the provider apart and real_money false is confirmed, and the request never names a provider", async () => {
    const example = integratedExample(loadMandate(join(AGENT_DIR, "mandate.example.json")), PROOF);
    const PUBLIC_LABEL = "Integrado (sandbox Celcoin) · sem dinheiro real";
    const view = { executor_provider: "celcoin", environment: "test", real_money: false };
    routes["GET /v1/consumers/funding-sources"] = celcoinSources;
    routes["POST /v1/consents/init"] = (b) => {
      const a = initAnswer("provider_sandbox", PUBLIC_LABEL)(b);
      return { ...a, body: { ...(a.body as object), ...view } };
    };
    routes["POST /v1/consents/tok_exec/submit"] = (b) => {
      const a = submitAnswer(example, "provider_sandbox", PUBLIC_LABEL, {}, CELCOIN_FS)(b);
      return { ...a, body: { ...(a.body as object), ...view } };
    };
    const c = await consent({ integrated: true });
    const mandate = await c.run;
    expect(mandate.canonical?.["funding_source_id"]).toBe(CELCOIN_FS);
    const before = c.before()!.join("\n");
    expect(before).toContain(`executor: ${PUBLIC_LABEL} (provider_sandbox, provedor celcoin, resolvido pela CodeSpar)`);
    expect(before).toContain("sem dinheiro real, mesmo quando o sandbox confirma o pagamento");
    expect(c.said.join("\n")).toContain(`Executor do mandato: ${PUBLIC_LABEL}.`);
    for (const p of [...posted("/v1/consents/init"), ...posted("/v1/consents/tok_exec/submit")]) {
      expect(p.body).not.toHaveProperty("provider");
      expect(p.body).not.toHaveProperty("executor_provider");
      expect((p.body["intent"] ?? {}) as object).not.toHaveProperty("provider");
    }
  });

  it("400 executor_provider_not_selectable: the API's words and what to do, nothing signed", async () => {
    routes["GET /v1/consumers/funding-sources"] = celcoinSources;
    routes["POST /v1/consents/init"] = () =>
      error(400, "executor_provider_not_selectable", "the provider is resolved by the server; send only `executor`. Nothing was created", { field: "provider" });
    const c = await consent({ integrated: true });
    await expect(c.run).rejects.toMatchObject({ name: "ConsentRefusedError", code: "executor_provider_not_selectable" });
    expect(c.said.join("\n")).toMatch(/resolvido pela CodeSpar antes da assinatura/);
    expect(posted("/v1/consents/tok_exec/submit")).toHaveLength(0);
    expect(existsSync(c.mandatePath)).toBe(false);
  });

  it("409 provider_sandbox_not_ready at init: what is missing and the next steps are said, the simulator is named, and NOT taken", async () => {
    routes["GET /v1/consumers/funding-sources"] = celcoinSources;
    routes["POST /v1/consents/init"] = () => error(409, "provider_sandbox_not_ready", "the project's provider sandbox is not ready for a payment mandate; nothing was created", NOT_READY_DETAILS);
    const c = await consent({ integrated: true });
    await expect(c.run).rejects.toMatchObject({ name: "ConsentRefusedError", code: "provider_sandbox_not_ready" });
    const text = c.said.join("\n");
    expect(text).toContain("O sandbox do provedor deste projeto não está pronto: nada foi assinado e nada foi trocado pelo simulador.");
    expect(text).toContain("  falta: sandbox_account_not_bound");
    expect(text).toContain("  falta: payments_capability_inactive");
    for (const step of NOT_READY_DETAILS.next_steps) expect(text).toContain(`  próximo passo: ${step}`);
    expect(text).toMatch(/alternativa: um consentimento com executor codespar_simulator/);
    // Never a fallback: one init, on provider_sandbox, and nothing after it.
    expect(posted("/v1/consents/init").map((p) => p.body["executor"])).toEqual(["provider_sandbox"]);
    expect(posted("/v1/consents/tok_exec/submit")).toHaveLength(0);
    expect(c.before()).toBeNull();
    expect(existsSync(c.mandatePath)).toBe(false);
  });

  it("409 provider_sandbox_not_ready at the submit (the consumer is not bound): said the same way, nothing stored, no second consent", async () => {
    routes["GET /v1/consumers/funding-sources"] = celcoinSources;
    routes["POST /v1/consents/init"] = initAnswer("celcoin_sandbox", SANDBOX_LABEL);
    routes["POST /v1/consents/tok_exec/submit"] = () =>
      error(409, "provider_sandbox_not_ready", "the provider sandbox has no account bound to this consumer in this project; nothing was signed and the consent is still pending", {
        missing: ["proof_account_not_bound"],
        next_steps: ["the integrated proof's consumer has no active Celcoin account in this project yet: the operator binds it"],
        alternative: { executor: "codespar_simulator" },
      });
    const c = await consent({ integrated: true, locale: "en" });
    await expect(c.run).rejects.toMatchObject({ code: "provider_sandbox_not_ready" });
    const text = c.said.join("\n");
    expect(text).toContain("  missing: proof_account_not_bound");
    expect(text).toContain("  next step: the integrated proof's consumer has no active Celcoin account in this project yet: the operator binds it");
    expect(text).toMatch(/alternative: a consent with executor codespar_simulator .* not an automatic fallback/);
    expect(posted("/v1/consents/init")).toHaveLength(1);
    expect(posted("/v1/consents/tok_exec/submit")).toHaveLength(1);
    expect(existsSync(c.mandatePath)).toBe(false);
  });

  it("an error that is not an executor refusal goes on unchanged", async () => {
    routes["GET /v1/consumers/funding-sources"] = celcoinSources;
    routes["POST /v1/consents/init"] = () => error(400, "periodic_cap_never_binds", "window at or above lifetime");
    const c = await consent({ integrated: true });
    await expect(c.run).rejects.not.toBeInstanceOf(ConsentRefusedError);
  });
});
