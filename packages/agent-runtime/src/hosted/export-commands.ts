/**
 * The commands a hosted run's export hands a person (CONTRATO §8, `code.commands`):
 * the same kit, at the commit the run used, on their machine.
 *
 * WHY THE WHOLE REPOSITORY. A kit is an npm workspace: its package.json depends
 * on `@codespar/agent-core` and `@codespar/agent-runtime`, which live in
 * `packages/` of this repository and are not published to npm. A copy of the
 * kit's folder alone (`degit .../agents/<kit>`) cannot install: npm looks the
 * two packages up on the registry and answers E404. The commands therefore copy
 * the repository at the run's commit, install at its root (where the
 * workspaces resolve), and start the kit by its workspace. Nothing is
 * published for this, and the kit's README, which already says to install at
 * the root, is the one that comes with the copy.
 *
 * WHAT THE RUN USED, SAID AND ASKED FOR. The start command carries the run's
 * own choices: on `codespar-test` the CodeSpar API rail (`--rail api`), with a
 * model the model provider (`--provider anthropic`, and `ANTHROPIC_MODEL` when
 * the host names its model), the approval mode and the language. Each key the
 * command needs is named in a line the commands echo and is never written: the person
 * gets the CodeSpar Test key from the console and pastes it in the kit's
 * `.env`. A start that lacks one stops and names it, before a mandate is asked
 * for or a run is opened. A replay says it runs on the stub rail and repeats
 * the recorded conversation; nothing in it reaches CodeSpar.
 *
 * A CHARGE ON THE INTEGRATED TEST IS REPRODUCED THROUGH THE PUBLIC COLLECT
 * ROUTES (CONTRATO v1.6, decision D1 of 27/11/2026). On `codespar-test` a
 * charging kit (its executor requires `platform.charges`) charges through the
 * host's charge port: a receive proposal the person sends on its card, which
 * the platform issues as a Collect link at the provider's sandbox and its Test
 * payer pays. The kit's own `--rail api` makes the same calls with the
 * person's test key, through Collect's public routes (agent-core
 * `CollectChargeRail`): the link and its publish, the payer page's read until
 * it is paid, and, with `--simulate-payer`, the payer page's attempt and the
 * Test payer (`POST /v1/collect/attempts/{attemptId}/test-pay`). So the export
 * of such a run starts the kit with `--rail api`, names the key and what it
 * needs (a `csk_test_` key whose project has Collect on, with `collect:read`
 * and `collect:write`), and lists the routes. The lines describe the path in
 * the present tense and never say this run's charge was sent or paid: an
 * export may be taken before that, or after a refusal. A live key is refused
 * before any call, as on every rail here.
 */
import type { ExecutorId, HostedKitDescriptor, ModelMode } from "./contract.js";

/** The directory the copy lands in: the repository's own name. */
export const EXPORT_DIR = "agent-starter-kits";

export interface ExportBinding {
  modelMode: ModelMode;
  executor: ExecutorId;
  approvalMode: "human" | "mandate";
  locale: "pt-BR" | "en";
  exampleId: string | null;
}

export interface ExportExtras {
  /** The model the host ran, when it says which (`ModelPort.model`). Not a secret; a key never is passed here. */
  model?: string | undefined;
}

type Descriptor = Pick<HostedKitDescriptor, "id" | "source" | "examples" | "needsMandate" | "executors">;

/**
 * Whether the kit's codespar-test executor charges through the platform's receive proposals (v1.6): it requires
 * `platform.charges`. Keyed on the executor, not the tool effect: a `charge` tool on another rail is not a receive proposal.
 */
export function chargesThroughPlatform(d: Pick<HostedKitDescriptor, "executors">): boolean {
  return d.executors.some((e) => e.id === "codespar-test" && e.requires.includes("platform.charges"));
}

/** A model id is written into a shell line: only the characters model ids have. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const TEXT = {
  "pt-BR": {
    keys: (env: string, names: string[]) => `Preencha ${env}: ${names.join("; ")}. Sem elas, o último comando para e diz qual falta.`,
    codesparKey: "CODESPAR_API_KEY com uma chave de teste (csk_test_) que você cria no console da CodeSpar, em API keys, no modo de teste",
    modelKey: "ANTHROPIC_API_KEY com a sua chave da Anthropic",
    model: (model: string) => `Modelo do Playground: ${model}.`,
    consent: "Antes da primeira mensagem, o kit pede o seu consentimento para o mandato de teste.",
    firstTurn: (id: string, text: string) => `Exemplo ${id}: no Playground, a primeira mensagem foi ${JSON.stringify(text)}.`,
    replay: (id: string) => `Sem chave: o exemplo ${id} roda no trilho simulado (stub) e repete a conversa gravada (replay). Nada chega à CodeSpar.`,
    chargeHosted:
      "No Playground, a cobrança deste kit roda no Test integrado pela plataforma: é uma proposta de recebimento que uma pessoa envia no cartão da proposta, emitida como link do Collect no sandbox do provedor e paga pelo pagador de teste da CodeSpar.",
    chargeApi:
      "Aqui o kit faz as mesmas chamadas pelas rotas públicas do Collect, com a sua chave: POST /v1/collect/links e POST /v1/collect/links/{linkId}/publish (o link, com o nome do devedor), GET /v1/collect/{linkId} até o pagamento, e GET /v1/collect/links/{linkId}/payments para o recibo do Collect (clr_).",
    chargeKey:
      "A chave de teste precisa de collect:read e collect:write, num projeto de teste com o Collect ligado (o mesmo projeto do Playground). Uma chave live é recusada antes de qualquer chamada. Opcional: CODESPAR_COLLECT_RECEIVER com a conta que recebe; sem ela, o Collect escolhe a conta do projeto.",
    chargePayer:
      "Com --simulate-payer, o pagador de teste da CodeSpar paga a cobrança uma vez, com um Pix real no sandbox do provedor (POST /v1/collect/{linkId}/attempts e POST /v1/collect/attempts/{attemptId}/test-pay). Sem ele, o kit mostra o link do Collect para uma pessoa pagar na página de teste.",
    chargeScenario: (id: string) =>
      `Sem chave: o exemplo ${id} repete a conversa gravada (replay) no trilho simulado (stub), com as datas da gravação, e nada chega à CodeSpar. Para fazer as chamadas do Collect com a sua chave de teste, rode com um modelo: --rail api --simulate-payer --wait 300 --provider anthropic.`,
  },
  en: {
    keys: (env: string, names: string[]) => `Fill in ${env}: ${names.join("; ")}. Without them, the last command stops and says which one is missing.`,
    codesparKey: "CODESPAR_API_KEY with a test key (csk_test_) you create in the CodeSpar console, under API keys, in test mode",
    modelKey: "ANTHROPIC_API_KEY with your Anthropic key",
    model: (model: string) => `The Playground's model: ${model}.`,
    consent: "Before the first message, the kit asks for your consent to the test mandate.",
    firstTurn: (id: string, text: string) => `Example ${id}: in the Playground, the first message was ${JSON.stringify(text)}.`,
    replay: (id: string) => `No key: example ${id} runs on the simulated rail (stub) and repeats the recorded conversation (replay). Nothing reaches CodeSpar.`,
    chargeHosted:
      "In the Playground, this kit's charge runs on the integrated Test through the platform: a receive proposal a person sends on the proposal card, issued as a Collect link at the provider's sandbox and paid by the CodeSpar Test payer.",
    chargeApi:
      "Here the kit makes the same calls through Collect's public routes, with your key: POST /v1/collect/links and POST /v1/collect/links/{linkId}/publish (the link, with the debtor's name), GET /v1/collect/{linkId} until it is paid, and GET /v1/collect/links/{linkId}/payments for the Collect receipt (clr_).",
    chargeKey:
      "The test key needs collect:read and collect:write, in a test project with Collect on (the Playground's own project). A live key is refused before any call. Optional: CODESPAR_COLLECT_RECEIVER with the receiving account; without it, Collect picks the project's account.",
    chargePayer:
      "With --simulate-payer, the CodeSpar Test payer pays the charge once, with a real Pix at the provider's sandbox (POST /v1/collect/{linkId}/attempts and POST /v1/collect/attempts/{attemptId}/test-pay). Without it, the kit shows the Collect link for a person to pay on the test page.",
    chargeScenario: (id: string) =>
      `No key: example ${id} repeats the recorded conversation (replay) on the simulated rail (stub), with the recording's dates, and nothing reaches CodeSpar. To make the Collect calls with your test key, run it with a model: --rail api --simulate-payer --wait 300 --provider anthropic.`,
  },
} as const;

/**
 * A line said to the person, as a command: `echo` and not a `#` comment, because an interactive zsh (the macOS
 * default) runs a pasted `# ...` line as a command named `#`. Single quotes: nothing in it is expanded.
 */
function say(line: string): string {
  return `echo '${line.replaceAll("'", `'\\''`)}'`;
}

export function exportCommands(d: Descriptor, b: ExportBinding, extras: ExportExtras = {}): string[] {
  const text = TEXT[b.locale];
  const kitDir = `agents/${d.id}`;
  const env = `${kitDir}/.env`;
  const withModel = b.modelMode === "model";
  const replayed = b.modelMode === "replay" && b.exampleId !== null;
  const platformCharge = b.executor === "codespar-test" && chargesThroughPlatform(d);
  // On the integrated Test the kit runs on its CodeSpar API rail, a charge through Collect's public routes (see above). A
  // charge's replay stays on the stub: a recording's due dates and collection hours are the recording's, and on the API rail
  // the clock is the wall clock, so the recorded charge would be refused as outside the envelope.
  const integrated = b.executor === "codespar-test" && !(platformCharge && replayed);
  const model = withModel && extras.model && MODEL_ID.test(extras.model) ? extras.model : undefined;
  const example = b.exampleId === null ? undefined : d.examples.find((e) => e.id === b.exampleId);

  const lines = [`npx degit ${d.source.repository}#${d.source.commit} ${EXPORT_DIR}`, `cd ${EXPORT_DIR} && npm install`];

  const keys = [...(integrated ? [text.codesparKey] : []), ...(withModel ? [text.modelKey] : [])];
  if (keys.length > 0) {
    // -n: a .env already there (with the person's keys) is never overwritten.
    lines.push(`cp -n ${kitDir}/.env.example ${env}`, say(text.keys(env, keys)));
  }
  if (model) lines.push(say(text.model(model)));
  // A charging kit's policy is the merchant's own example file: it has no consent step to announce.
  if (integrated && d.needsMandate && !platformCharge) lines.push(say(text.consent));
  if (withModel && example) lines.push(say(text.firstTurn(example.id, example.turns[0].input)));
  if (platformCharge) lines.push(say(text.chargeHosted), ...(integrated ? [say(text.chargeApi), say(text.chargeKey), say(text.chargePayer)] : [say(text.chargeScenario(b.exampleId!))]));
  if (replayed && !integrated && !platformCharge) lines.push(say(text.replay(b.exampleId!)));

  const flags = [
    ...(replayed ? ["--scenario", b.exampleId!] : []),
    ...(integrated ? ["--rail", "api"] : platformCharge ? ["--rail", "stub"] : []),
    // The Test payer is the Playground's "Pagador de teste paga". The wait covers the Pix's issuance at the provider's
    // sandbox and the Test payer's payment.
    ...(platformCharge && integrated ? ["--simulate-payer", "--wait", "300"] : []),
    ...(withModel ? ["--provider", "anthropic"] : []),
    "--mode",
    b.approvalMode,
    "--locale",
    b.locale,
  ];
  lines.push(`${model ? `ANTHROPIC_MODEL=${model} ` : ""}npm start --workspace=${kitDir} -- ${flags.join(" ")}`);
  return lines;
}
