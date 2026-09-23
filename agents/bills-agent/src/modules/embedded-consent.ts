/**
 * Module `embedded-consent`: the mandate is born at a hosted consent page
 * the CONSUMER signs; this backend only starts it and waits. With a test
 * key and no `.codespar/mandate.json`, `npm start` runs this first. The
 * result is stored locally with the shape the core reads; the signature
 * the API returns is never needed, because the kit spends by mandate id.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApiClient } from "@codespar/sdk";
import { MandateSchema, type Mandate, describeApiError } from "@codespar/agent-core";

export interface ConsentOptions {
  api: ApiClient;
  example: Mandate;
  mandatePath: string;
  /** Where to write the URL the person opens. */
  say: (line: string) => void;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const YEAR_SECONDS = 365 * 24 * 3600;

export function loadLocalMandate(path: string): Mandate | undefined {
  if (!existsSync(path)) return undefined;
  return MandateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function runEmbeddedConsent(options: ConsentOptions): Promise<Mandate> {
  const { api, example, say } = options;
  const now = options.now ?? (() => new Date());
  const startedAt = now();

  const init = await api.post("/v1/consents/init", {
    body: {
      agent_id: example.agent_id,
      intent: {
        purpose: example.purpose,
        cap_minor: example.cap_minor,
        per_tx_cap_minor: example.per_tx_cap_minor,
        currency: "BRL",
        mandate_ttl_seconds: YEAR_SECONDS,
        merchant_allowlist: example.beneficiaries.map((b) => b.payee),
        merchant_pin_kind: "pix-key",
        ...(example.periodic_cap ? { periodic_cap: example.periodic_cap } : {}),
        display_name: "bills-agent: contas do mes",
        intent_note: `Pagar as contas do mes aos favorecidos nomeados: ${example.beneficiaries.map((b) => b.name).join(", ")}.`,
      },
      surface: "hosted",
    },
  });

  say("");
  say("O mandato ainda nao existe. Abra este link e assine o consentimento (sandbox):");
  say(`  ${init.consent_url}`);
  say(`  (o link vale ate ${init.expires_at})`);
  say("Aguardando a assinatura...");

  const deadline = startedAt.getTime() + (options.timeoutMs ?? 10 * 60 * 1000);
  const pollMs = options.pollMs ?? 3000;
  while (now().getTime() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    let listing: { mandates: Array<Record<string, unknown>> };
    try {
      listing = (await api.get("/v1/mandates", { query: { status: "active", limit: 50 } })) as { mandates: Array<Record<string, unknown>> };
    } catch (err) {
      const f = describeApiError(err);
      say(`  ...ainda aguardando (${f.code})`);
      continue;
    }
    const fresh = listing.mandates
      .filter((m) => m["agent_id"] === example.agent_id && new Date(String(m["created_at"])).getTime() >= startedAt.getTime() - 60_000)
      .sort((a, b) => String(b["created_at"]).localeCompare(String(a["created_at"])))[0];
    if (!fresh) continue;

    const mandate = MandateSchema.parse({
      id: String(fresh["id"]),
      version: 1,
      consumer_id: String(fresh["consumer_id"]),
      agent_id: String(fresh["agent_id"]),
      purpose: String(fresh["purpose"]),
      currency: String(fresh["currency"]),
      cap_minor: Number(fresh["cap_minor"]),
      per_tx_cap_minor: Number(fresh["per_tx_cap_minor"]),
      ...(example.periodic_cap ? { periodic_cap: { ...example.periodic_cap, cap_minor: Math.min(example.periodic_cap.cap_minor, Number(fresh["cap_minor"])) } } : {}),
      merchant_pin_kind: String(fresh["merchant_pin_kind"]),
      merchant_allowlist: fresh["merchant_allowlist"],
      beneficiaries: example.beneficiaries.filter((b) => (fresh["merchant_allowlist"] as string[]).includes(b.payee)),
      status: String(fresh["status"]),
      expires_at: new Date(String(fresh["expires_at"])).toISOString(),
      source: "consent",
    });

    mkdirSync(dirname(options.mandatePath), { recursive: true });
    writeFileSync(options.mandatePath, JSON.stringify(mandate, null, 2) + "\n", { mode: 0o600 });
    chmodSync(options.mandatePath, 0o600);
    say(`Mandato assinado: ${mandate.id} (consumidor ${mandate.consumer_id}).`);

    await fundSandbox(api, mandate, say);
    return mandate;
  }
  throw new Error("consent not signed in time; run `npm run consent` to start again");
}

/** Section 15 of the spec: the sandbox account is credited so the first spend has a balance. */
export async function fundSandbox(api: ApiClient, mandate: Mandate, say: (line: string) => void): Promise<void> {
  try {
    const funded = await api.post("/v1/test/fund", { body: { consumer_id: mandate.consumer_id, amount_minor: mandate.cap_minor } });
    say(`Sandbox creditado: ${funded.amount_minor} centavos em ${funded.account} (deposit ${funded.deposit_id}).`);
  } catch (err) {
    const f = describeApiError(err);
    say(`Nao foi possivel creditar o sandbox automaticamente (${f.code}: ${f.message}). Use \`npx @codespar/cli@0.12.1 test fund\` e tente de novo.`);
  }
}
