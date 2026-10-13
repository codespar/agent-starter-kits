/**
 * The bills-agent against the restricted integrated Celcoin proof: the named
 * consumer pays from its own `fs_celcoin_<consumer>` source, or nothing is
 * created; the mandate refuses above its R$ 10,00 caps; and the consent never
 * funds the account.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "@codespar/sdk";
import { loadMandate, type Mandate } from "@codespar/agent-core";
import { harness } from "../../../packages/agent-core/test/helpers.js";
import { runEmbeddedConsent } from "../src/modules/embedded-consent.js";
import {
  INTEGRATED_BILLS,
  INTEGRATED_CAP_MINOR,
  IntegratedProofError,
  RECEIVER_ALIAS,
  assertMandateBinding,
  integratedExample,
  integratedProofFrom,
} from "../src/modules/integrated-proof.js";
import { listBills } from "../src/modules/pix-out.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const PROOF = { consumerId: "cst_prova_test", receiverKey: "00000000-0000-4000-8000-000000000001" };
const CELCOIN_FS = "fs_celcoin_cst_prova_test";

interface Fake {
  api: ApiClient;
  posts: string[];
}

/** The API as the proof's project answers it: `sources` is what GET /v1/consumers/funding-sources lists, `signed` what the submit signs. */
function fakeApi(sources: Array<Record<string, unknown>>, signed: Partial<{ consumer_id: string; funding_source_id: string }> = {}): Fake {
  const posts: string[] = [];
  const api = {
    get: async (path: string) => {
      if (path === "/v1/consumers/funding-sources") return { funding_sources: sources, unattributed_count: 0 };
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string) => {
      posts.push(path);
      if (path === "/v1/consents/init") return { token: "tok_test", expires_at: "2026-10-12T18:30:00.000Z" };
      if (path === "/v1/consents/{token}/submit") {
        return {
          mandate_id: "cm_proof",
          signature: "0".repeat(64),
          mandate: {
            consumer_id: signed.consumer_id ?? PROOF.consumerId,
            funding_source_id: signed.funding_source_id ?? CELCOIN_FS,
            agent_id: "bills-agent",
            purpose: "conta de teste da prova integrada",
            currency: "BRL",
            cap_minor: INTEGRATED_CAP_MINOR,
            per_tx_cap_minor: INTEGRATED_CAP_MINOR,
            merchant_pin_kind: "pix-key",
            merchant_allowlist: [PROOF.receiverKey],
            expires_at: 1821312000,
          },
        };
      }
      return { amount_minor: 1, account: "acc", deposit_id: "dep" };
    },
  };
  return { api: api as unknown as ApiClient, posts };
}

const celcoinRow = (over: Record<string, unknown> = {}) => ({ id: CELCOIN_FS, consumer_id: PROOF.consumerId, rail: "pix-celcoin", status: "active", ...over });

function example(): Mandate {
  return integratedExample(loadMandate(resolve(AGENT_DIR, "mandate.example.json")), PROOF);
}

async function consent(fake: Fake) {
  const mandatePath = join(mkdtempSync(join(tmpdir(), "bills-proof-")), "mandate.json");
  const said: string[] = [];
  const run = runEmbeddedConsent({ api: fake.api, example: example(), mandatePath, say: (l) => said.push(l), confirm: async () => true, integrated: PROOF });
  return { run, mandatePath, said };
}

describe("the proof's settings", () => {
  afterEach(() => {
    delete process.env["BILLS_CONSUMER_ID"];
    delete process.env["BILLS_PROOF_RECEIVER_KEY"];
  });

  it("are off without either variable, and refused when half or malformed", () => {
    expect(integratedProofFrom({})).toBeNull();
    expect(integratedProofFrom({ BILLS_CONSUMER_ID: "cst_prova_test", BILLS_PROOF_RECEIVER_KEY: PROOF.receiverKey })).toEqual(PROOF);
    expect(() => integratedProofFrom({ BILLS_CONSUMER_ID: "cst_prova_test" })).toThrow(IntegratedProofError);
    expect(() => integratedProofFrom({ BILLS_CONSUMER_ID: "org_x:12345678909", BILLS_PROOF_RECEIVER_KEY: PROOF.receiverKey })).toThrow(/BILLS_CONSUMER_ID/);
    expect(() => integratedProofFrom({ BILLS_CONSUMER_ID: "cst_prova_test", BILLS_PROOF_RECEIVER_KEY: "+5511999990001" })).toThrow(/EVP/);
  });

  it("rewrite the mandate to the consumer, one payee (the test receiver) and R$ 10,00 caps", () => {
    const m = example();
    expect(m.consumer_id).toBe(PROOF.consumerId);
    expect([m.cap_minor, m.per_tx_cap_minor, m.periodic_cap?.cap_minor]).toEqual([1000, 1000, 1000]);
    expect(m.beneficiaries).toEqual([{ alias: RECEIVER_ALIAS, name: "Recebedor de teste da prova", payee: PROOF.receiverKey }]);
    expect(m.merchant_allowlist).toEqual([PROOF.receiverKey]);
  });

  it("list the proof's bills instead of the month's, both to the test receiver", async () => {
    process.env["BILLS_CONSUMER_ID"] = PROOF.consumerId;
    process.env["BILLS_PROOF_RECEIVER_KEY"] = PROOF.receiverKey;
    const h = harness({ mandate: { beneficiaries: [{ alias: RECEIVER_ALIAS, name: "Recebedor de teste da prova", payee: PROOF.receiverKey }] } });
    const out = (await listBills({}, { engine: h.engine } as never)) as { bills: Array<{ alias: string; amount_minor: number }> };
    expect(out.bills.map((b) => [b.alias, b.amount_minor])).toEqual(INTEGRATED_BILLS.map((b) => [b.alias, b.amount_minor]));
  });
});

describe("the wrong consumer, or no Celcoin binding: nothing is created", () => {
  it("no active Celcoin source of the consumer: refused before /v1/consents/init", async () => {
    for (const sources of [[], [celcoinRow({ status: "inactive" })], [celcoinRow({ rail: "pix-consent", id: "cfs_x" })], [celcoinRow(), celcoinRow({ id: "fs_celcoin_other" })]]) {
      const fake = fakeApi(sources);
      const { run, mandatePath } = await consent(fake);
      await expect(run).rejects.toMatchObject({ code: "no_celcoin_source" });
      expect(fake.posts).toEqual([]);
      expect(existsSync(mandatePath)).toBe(false);
    }
  });

  it("a source the API lists under another consumer: refused before any write", async () => {
    const fake = fakeApi([celcoinRow({ consumer_id: "cst_someone_else" })]);
    const { run } = await consent(fake);
    await expect(run).rejects.toMatchObject({ code: "wrong_consumer" });
    expect(fake.posts).toEqual([]);
  });

  it("a signed mandate for another consumer or another source is not stored", async () => {
    for (const [signed, code] of [[{ consumer_id: "cst_someone_else" }, "wrong_consumer"], [{ funding_source_id: "cfs_newpixconsent" }, "wrong_funding_source"]] as const) {
      const fake = fakeApi([celcoinRow()], signed);
      const { run, mandatePath } = await consent(fake);
      await expect(run).rejects.toMatchObject({ code });
      expect(existsSync(mandatePath)).toBe(false);
    }
  });

  it("a local mandate of another consumer or source is refused, not used", () => {
    expect(() => assertMandateBinding({ consumer_id: "usr_demo_titular", canonical: { funding_source_id: "cfs_x" } }, PROOF, "local mandate")).toThrow(/another consumer/);
    expect(() => assertMandateBinding({ consumer_id: PROOF.consumerId, canonical: { funding_source_id: "cfs_x" } }, PROOF, "local mandate")).toThrow(/fs_celcoin_cst_prova_test/);
    expect(() => assertMandateBinding({ consumer_id: PROOF.consumerId, canonical: { funding_source_id: CELCOIN_FS } }, PROOF, "local mandate")).not.toThrow();
  });
});

describe("no new funding", () => {
  it("the consent signs on the Celcoin source and never calls /v1/test/fund", async () => {
    const fake = fakeApi([celcoinRow()]);
    const { run, mandatePath, said } = await consent(fake);
    const mandate = await run;
    expect(fake.posts).toEqual(["/v1/consents/init", "/v1/consents/{token}/submit"]);
    expect(fake.posts).not.toContain("/v1/test/fund");
    expect(mandate.consumer_id).toBe(PROOF.consumerId);
    expect(mandate.canonical?.["funding_source_id"]).toBe(CELCOIN_FS);
    expect(existsSync(mandatePath)).toBe(true);
    expect(said.join("\n")).toMatch(/Nada creditado/);
  });
});

describe("the mandate refuses above its caps", () => {
  it("R$ 20,00 (above the mandate's R$ 10,00, below the proof's R$ 50,00) is denied per_tx_cap_exceeded by the mandate; R$ 10,00 is not", async () => {
    const m = example();
    const h = harness({ mode: "mandate", mandate: { ...m, id: "mdt_proof_test" } });
    const over = await h.engine.draft({ items: [{ payee: RECEIVER_ALIAS, amount: 2000 }] });
    // The proof's own R$ 50,00 per-payment limit (API side) is not what refuses it: this is the mandate's cap, before any call.
    const reason = over.ok ? over.execution.reason : over.reason;
    expect(over.ok ? over.execution.state : "refused_before_draft").not.toBe("settled");
    expect(reason).toBe("per_tx_cap_exceeded");
    const within = await h.engine.draft({ items: [{ payee: RECEIVER_ALIAS, amount: 1000 }] });
    expect(within.ok).toBe(true);
  });

  it("in human mode R$ 20,00 is still a refusal, not a request for approval", async () => {
    const h = harness({ mode: "human", mandate: { ...example(), id: "mdt_proof_human" } });
    const over = await h.engine.draft({ items: [{ payee: RECEIVER_ALIAS, amount: 2000 }] });
    const state = over.ok ? over.execution.state : "refused_before_draft";
    const reason = over.ok ? over.execution.reason : over.reason;
    expect(state).not.toBe("awaiting_approval");
    expect(reason).toBe("per_tx_cap_exceeded");
  });
});
