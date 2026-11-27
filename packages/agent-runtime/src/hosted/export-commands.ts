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

type Descriptor = Pick<HostedKitDescriptor, "id" | "source" | "examples" | "needsMandate">;

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
  },
  en: {
    keys: (env: string, names: string[]) => `Fill in ${env}: ${names.join("; ")}. Without them, the last command stops and says which one is missing.`,
    codesparKey: "CODESPAR_API_KEY with a test key (csk_test_) you create in the CodeSpar console, under API keys, in test mode",
    modelKey: "ANTHROPIC_API_KEY with your Anthropic key",
    model: (model: string) => `The Playground's model: ${model}.`,
    consent: "Before the first message, the kit asks for your consent to the test mandate.",
    firstTurn: (id: string, text: string) => `Example ${id}: in the Playground, the first message was ${JSON.stringify(text)}.`,
    replay: (id: string) => `No key: example ${id} runs on the simulated rail (stub) and repeats the recorded conversation (replay). Nothing reaches CodeSpar.`,
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
  const integrated = b.executor === "codespar-test";
  const withModel = b.modelMode === "model";
  const replayed = b.modelMode === "replay" && b.exampleId !== null;
  const model = withModel && extras.model && MODEL_ID.test(extras.model) ? extras.model : undefined;
  const example = b.exampleId === null ? undefined : d.examples.find((e) => e.id === b.exampleId);

  const lines = [`npx degit ${d.source.repository}#${d.source.commit} ${EXPORT_DIR}`, `cd ${EXPORT_DIR} && npm install`];

  const keys = [...(integrated ? [text.codesparKey] : []), ...(withModel ? [text.modelKey] : [])];
  if (keys.length > 0) {
    // -n: a .env already there (with the person's keys) is never overwritten.
    lines.push(`cp -n ${kitDir}/.env.example ${env}`, say(text.keys(env, keys)));
  }
  if (model) lines.push(say(text.model(model)));
  if (integrated && d.needsMandate) lines.push(say(text.consent));
  if (withModel && example) lines.push(say(text.firstTurn(example.id, example.turns[0].input)));
  if (replayed && !integrated) lines.push(say(text.replay(b.exampleId!)));

  const flags = [
    ...(replayed ? ["--scenario", b.exampleId!] : []),
    ...(integrated ? ["--rail", "api"] : []),
    ...(withModel ? ["--provider", "anthropic"] : []),
    "--mode",
    b.approvalMode,
    "--locale",
    b.locale,
  ];
  lines.push(`${model ? `ANTHROPIC_MODEL=${model} ` : ""}npm start --workspace=${kitDir} -- ${flags.join(" ")}`);
  return lines;
}
