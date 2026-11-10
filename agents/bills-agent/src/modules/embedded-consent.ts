/**
 * Module `embedded-consent`: the mandate is born at a consent the CONSUMER
 * authorizes. In the sandbox the kit runs the `partner` surface: it is the
 * partner's backend, the titular is at the keyboard, and the submit carries
 * an `in_person` attestation. That is what hands the kit the signed envelope
 * `{ mandate, signature }`, which `POST /v1/consumer-payments/execute`
 * presents on every spend. The `hosted` surface (a page the consumer opens)
 * returns the envelope to a `callback_url` a terminal kit does not have;
 * see docs/OPEN_QUESTIONS.md.
 *
 * With a test key and no `.codespar/mandate.json`, `npm start` runs this
 * first. The stored file carries the signature: mode 0600, never in the
 * bundle, never committed.
 *
 * Who executes the payments is chosen here, before the titular signs, and
 * named to the API as `executor` (codespar-enterprise ent#1983): the
 * quickstart asks for `codespar_simulator` ("Simulado pela CodeSpar": no KYC,
 * no Mercado Pago, no bank account, nothing leaves CodeSpar), so the first
 * payment runs in Test right away; the integrated proof asks for
 * `provider_sandbox` (the Celcoin sandbox account bound to the consumer).
 * When the provider's sandbox is not ready the API says what is missing and
 * creates nothing, and this kit prints it and stops: it never falls back to
 * the simulator on its own. The executor the API confirms is shown before the
 * question and after the signature.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { ApiClient, ApiOperation, ApiRequestBody } from "@codespar/sdk";
import {
  ApiMandateStatusSource,
  CORE_STRINGS,
  MandateSchema,
  RECORDED_EXECUTOR,
  executorLabel,
  isExecutorRefusal,
  windowCap,
  type ConsentExecutor,
  type Locale,
  type Mandate,
  describeApiError,
} from "@codespar/agent-core";
import { STRINGS } from "../strings.js";
import { INTEGRATED_MANDATE_DAYS, assertCelcoinBinding, assertMandateBinding, type IntegratedProof } from "./integrated-proof.js";

export interface ConsentOptions {
  api: ApiClient;
  example: Mandate;
  mandatePath: string;
  /** The language of the lines below. Default pt-BR. */
  locale?: Locale;
  /** Where to write the lines the person reads. */
  say: (line: string) => void;
  /** Asks the titular to authorize. Returns true on yes. */
  confirm: (question: string) => Promise<boolean>;
  /** The consumer this mandate is for. Defaults to the example's. */
  consumerId?: string;
  /** The restricted integrated Celcoin proof: the consumer's Celcoin binding is checked first, and nothing is funded. */
  integrated?: IntegratedProof;
  now?: () => Date;
}

const YEAR_SECONDS = 365 * 24 * 3600;

/**
 * The consent stopped before a mandate was stored, for a reason the lines
 * already said (the provider's sandbox is not ready, a Live key, an executor
 * the API did not confirm). `npm run consent` exits 1 on it, with no stack.
 */
export class ConsentRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConsentRefusedError";
  }
}

/** The executor this consent asks for: the proof pays from the provider's sandbox, the quickstart from the simulator. */
export function consentExecutorFor(options: Pick<ConsentOptions, "integrated">): ConsentExecutor {
  return options.integrated ? "provider_sandbox" : "codespar_simulator";
}

/** A string field of an API answer the SDK's types may predate (`executor`, `executor_label`); anything else is absent. */
function field(answer: unknown, name: string): string | null {
  if (!answer || typeof answer !== "object" || !(name in answer)) return null;
  const value = (answer as Record<string, unknown>)[name];
  return typeof value === "string" && value ? value : null;
}

interface SandboxNotReadyDetails {
  missing: string[];
  next_steps: string[];
  alternative: string | null;
}

/** `details` of a 409 `provider_sandbox_not_ready`, read defensively: lists of strings, and the alternative executor the API names. */
function sandboxNotReadyDetails(body: unknown): SandboxNotReadyDetails {
  const error = body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : undefined;
  const details = error && typeof error === "object" && "details" in error ? (error as { details: unknown }).details : undefined;
  const d = (details && typeof details === "object" ? details : {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { missing: strings(d["missing"]), next_steps: strings(d["next_steps"]), alternative: field(d["alternative"], "executor") };
}

/**
 * The refusals of ent#1983 a person can act on, said in lines and turned into
 * a `ConsentRefusedError`; every other error goes on unchanged.
 */
function refuseReadably(err: unknown, say: (line: string) => void, locale: Locale): never {
  const failure = describeApiError(err);
  const text = STRINGS[locale];
  const hint = isExecutorRefusal(failure.code) ? CORE_STRINGS[locale].executorHint(failure.code) : null;
  if (failure.code === "provider_sandbox_not_ready") {
    const details = sandboxNotReadyDetails(failure.body);
    say(text.consentSandboxNotReady);
    for (const gap of details.missing) say(text.consentSandboxMissing(gap));
    for (const step of details.next_steps) say(text.consentSandboxNextStep(step));
    if (details.alternative) say(text.consentSandboxAlternative(details.alternative));
    throw new ConsentRefusedError(failure.code, `${failure.code}: ${failure.message}`);
  }
  if (hint) {
    say(`${failure.code}: ${failure.message}`);
    say(hint);
    throw new ConsentRefusedError(failure.code, `${failure.code}: ${failure.message}`);
  }
  throw err;
}

export function loadLocalMandate(path: string): Mandate | undefined {
  if (!existsSync(path)) return undefined;
  return MandateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The words for what the API says of the mandate the file already holds; `unknown` is the API not answering. */
const PREVIOUS = {
  active: "consentPreviousActive",
  paused: "consentPreviousPaused",
  revoked: "consentPreviousRevoked",
  expired: "consentPreviousExpired",
  unknown: "consentPreviousUnknown",
} as const;

/** The mandate the file holds before this consent, when it holds one this kit can read. A file it cannot read is not a reason to stop a new consent. */
function previousMandate(path: string): Mandate | undefined {
  try {
    return loadLocalMandate(path);
  } catch {
    return undefined;
  }
}

export async function runEmbeddedConsent(options: ConsentOptions): Promise<Mandate> {
  const { api, example, say } = options;
  const locale = options.locale ?? "pt-BR";
  const text = STRINGS[locale];
  const now = options.now ?? (() => new Date());
  const consumerId = options.integrated?.consumerId ?? options.consumerId ?? example.consumer_id;
  // Before any write: the proof's consumer pays from exactly its own Celcoin source. The API checks the binding too
  // (`provider_sandbox`, 409 `provider_sandbox_not_ready`); the proof's stricter rule is held here first, with nothing created.
  if (options.integrated) await assertCelcoinBinding(api, options.integrated);

  const executor = consentExecutorFor(options);
  // `executor` is ent#1983's, chosen before anyone signs; the SDK's types predate it (see `initConsent`).
  const initBody: Parameters<typeof initConsent>[1] = {
    agent_id: example.agent_id,
    intent: {
      purpose: example.purpose,
      cap_minor: example.cap_minor,
      per_tx_cap_minor: example.per_tx_cap_minor,
      currency: "BRL",
      mandate_ttl_seconds: options.integrated ? INTEGRATED_MANDATE_DAYS * 24 * 3600 : YEAR_SECONDS,
      merchant_allowlist: example.beneficiaries.map((b) => b.payee),
      merchant_pin_kind: "pix-key",
      ...(example.periodic_cap ? { periodic_cap: example.periodic_cap } : {}),
      display_name: "bills-agent: contas do mês",
      intent_note: `Pagar as contas do mês aos favorecidos nomeados: ${example.beneficiaries.map((b) => b.name).join(", ")}.`,
    },
    surface: "partner",
    executor,
  };
  let init: Awaited<ReturnType<typeof initConsent>>;
  try {
    init = await initConsent(api, initBody);
  } catch (err) {
    refuseReadably(err, say, locale);
  }
  // The API answers the executor it recorded for this token. One that does not say, or says another, did not take
  // the choice (an API before ent#1983): the person is not asked to sign a mandate whose executor nobody confirmed.
  const confirmed = field(init, "executor");
  if (confirmed !== RECORDED_EXECUTOR[executor]) {
    say(text.consentExecutorNotConfirmed(executor, confirmed));
    throw new ConsentRefusedError("executor_not_confirmed", `the API did not confirm executor ${executor} (answered ${confirmed ?? "none"}); nothing was signed`);
  }
  const label = field(init, "executor_label") ?? executorLabel(confirmed);

  // A consent after a revocation is not a first one: the file holds the mandate it replaces, and the API says what became of it.
  const previous = previousMandate(options.mandatePath);
  const state = previous ? (await new ApiMandateStatusSource(api, now).check(previous.id)).status : undefined;

  say("");
  say(previous && state ? text.consentReplaces(previous.id, text[PREVIOUS[state]], relative(process.cwd(), options.mandatePath)) : text.consentHeader);
  say(text.consentAgent(example.agent_id, example.purpose));
  say(text.consentCaps(example.per_tx_cap_minor, windowCap(example), example.cap_minor));
  for (const b of example.beneficiaries) say(text.consentPayee(b.name, b.alias));
  say(options.integrated ? text.consentValidityDays(INTEGRATED_MANDATE_DAYS, init.expires_at) : text.consentValidity(init.expires_at));
  say(text.consentExecutor(label, confirmed, executor));
  const yes = await options.confirm(text.consentQuestion);
  if (!yes) throw new Error("consent not authorized by the titular; nothing was created");

  // The consumer's "browser" is this terminal: the submit is the same call the hosted page makes,
  // plus the attestation the partner surface requires. Sandbox rails accept a placeholder token.
  // A consent opened with an executor is submitted on `pix-consent` (else 400 `executor_rail_mismatch`).
  let submitted: Awaited<ReturnType<typeof submitConsent>>;
  try {
    submitted = await submitConsent(api, init.token, {
      consumer_id: consumerId,
      rail: "pix-consent",
      provider_token: `sandbox-pix-consent-${consumerId}`,
      display_label: "bills-agent (sandbox)",
      attestation: { method: "in_person", asserted_at: Math.floor(now().getTime() / 1000), reference: "terminal" },
    });
  } catch (err) {
    // A 409 `provider_sandbox_not_ready` here keeps the token pending: nothing was signed.
    refuseReadably(err, say, locale);
  }
  // The executor the signed source carries. Anything but the one confirmed above is not stored as this kit's mandate.
  const signedExecutor = field(submitted, "executor");
  const guidance = (submitted as { executor_guidance?: unknown }).executor_guidance;
  if (guidance) say(text.consentExecutorGuidance(field(guidance, "code") ?? "funding_source_executor_required", field(guidance, "message") ?? ""));
  if (signedExecutor !== confirmed) {
    say(text.consentExecutorSignedOther(submitted.mandate_id, confirmed, signedExecutor));
    throw new ConsentRefusedError("executor_not_confirmed", `the signed mandate ${submitted.mandate_id} carries executor ${signedExecutor ?? "none"}, not ${confirmed}; it was not stored`);
  }

  const signed = submitted.mandate;
  const allowlist = signed["merchant_allowlist"];
  const mandate = MandateSchema.parse({
    id: submitted.mandate_id,
    version: 1,
    consumer_id: String(signed["consumer_id"]),
    agent_id: String(signed["agent_id"]),
    purpose: String(signed["purpose"]),
    currency: String(signed["currency"]),
    cap_minor: Number(signed["cap_minor"]),
    per_tx_cap_minor: Number(signed["per_tx_cap_minor"]),
    ...(signed["periodic_cap"] ? { periodic_cap: signed["periodic_cap"] } : {}),
    merchant_pin_kind: String(signed["merchant_pin_kind"]),
    merchant_allowlist: allowlist,
    beneficiaries: example.beneficiaries.filter((b) => Array.isArray(allowlist) && allowlist.includes(b.payee)),
    status: "active",
    expires_at: new Date(Number(signed["expires_at"]) * 1000).toISOString(),
    signature: submitted.signature,
    canonical: signed,
    source: "consent",
  });

  if (options.integrated) assertMandateBinding(mandate, options.integrated, "signed mandate");

  mkdirSync(dirname(options.mandatePath), { recursive: true });
  writeFileSync(options.mandatePath, JSON.stringify(mandate, null, 2) + "\n", { mode: 0o600 });
  chmodSync(options.mandatePath, 0o600);
  say(text.consentSigned(mandate.id, mandate.consumer_id));
  say(text.consentExecutorSigned(field(submitted, "executor_label") ?? executorLabel(signedExecutor)));

  // The proof's account is credited once, by the operator, under the proof's own ceiling: never from here.
  if (options.integrated) say(text.consentNotFundedIntegrated);
  else await fundSandbox(api, mandate, say, options.locale);
  return mandate;
}

/** `POST /v1/consents/init` (the deprecated alias of `POST /v1/consents`, same handler), with ent#1983's `executor`, which @codespar/sdk 0.16.16's types predate. */
function initConsent(api: ApiClient, body: ApiRequestBody<ApiOperation<"/v1/consents/init", "post">> & { executor: ConsentExecutor }) {
  return api.post("/v1/consents/init", { body });
}

function submitConsent(api: ApiClient, token: string, body: ApiRequestBody<ApiOperation<"/v1/consents/{token}/submit", "post">>) {
  return api.post("/v1/consents/{token}/submit", { path: { token }, body });
}

/** Best effort: the sandbox account is credited with one window's cap. A `pix-consent` source has no Celcoin account to credit, and the sandbox spend does not need one. */
export async function fundSandbox(api: ApiClient, mandate: Mandate, say: (line: string) => void, locale: Locale = "pt-BR"): Promise<void> {
  const text = STRINGS[locale];
  try {
    const funded = await api.post("/v1/test/fund", { body: { consumer_id: mandate.consumer_id, amount_minor: windowCap(mandate) } });
    say(text.consentFunded(funded.amount_minor, funded.account, funded.deposit_id));
  } catch (err) {
    const f = describeApiError(err);
    say(text.consentNotFunded(f.code));
  }
}
