#!/usr/bin/env node
/**
 * Portuguese a person reads is written with its accents. This finds the
 * common words that lost them.
 *
 * WHY A LIST AND NOT A DICTIONARY. The kits mix English and Portuguese in one
 * file all the time, and a spell checker would drown in the English. The
 * words below are the ones this repository actually lost accents on, each one
 * a word that has no unaccented spelling in Portuguese and no English
 * homograph worth the noise. A new string usually copies an old one, so the
 * list only has to hold the words that were copied.
 *
 * WHAT IS NOT PROSE. A word joined to an identifier by `_`, `-`, `/` or `@`
 * (`agora_nao`, `avaliacao-inicial`, `America/Sao_Paulo`) is a name, never a
 * sentence, and is not read. Machine values that are compared somewhere and
 * spelled bare are in ALLOW and ALIASES, each with the reason it cannot
 * change. What a person types is not read either (`typedSpans`), and neither
 * is test code; the fixtures a test replays are.
 *
 * Usage:
 *   node scripts/pt-accents.mjs            scan the tree, exit 1 on a finding
 *   node scripts/pt-accents.mjs <root>     scan another checkout (the test plants one)
 *   node scripts/pt-accents.mjs --fix      rewrite every finding with its accent, then scan
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** unaccented -> accented. Matched as whole words, case-insensitively. */
export const WORDS = {
  nao: "não",
  voce: "você",
  voces: "vocês",
  execucao: "execução",
  execucoes: "execuções",
  digitavel: "digitável",
  unico: "único",
  unica: "única",
  cobranca: "cobrança",
  cobrancas: "cobranças",
  opcao: "opção",
  opcoes: "opções",
  ate: "até",
  sao: "são",
  ja: "já",
  tambem: "também",
  entao: "então",
  situacao: "situação",
  condicao: "condição",
  condicoes: "condições",
  emissao: "emissão",
  decisao: "decisão",
  confirmacao: "confirmação",
  atualizacao: "atualização",
  avaliacao: "avaliação",
  avaliacoes: "avaliações",
  politica: "política",
  numero: "número",
  numeros: "números",
  minimo: "mínimo",
  maximo: "máximo",
  horario: "horário",
  vitalicio: "vitalício",
  mes: "mês",
  possivel: "possível",
  disponivel: "disponível",
  indisponivel: "indisponível",
  catalogo: "catálogo",
  catalogos: "catálogos",
  estudio: "estúdio",
  preco: "preço",
  precos: "preços",
  servico: "serviço",
  servicos: "serviços",
  apos: "após",
  proximo: "próximo",
  proxima: "próxima",
  ultimo: "último",
  ultima: "última",
  tres: "três",
  pendencias: "pendências",
  pendencia: "pendência",
  conferencia: "conferência",
  codigo: "código",
  estao: "estão",
  sera: "será",
  negociacao: "negociação",
  endereco: "endereço",
  orcamento: "orçamento",
  funcionaria: "funcionária",
  grafica: "gráfica",
  agua: "água",
  instrucao: "instrução",
  informacao: "informação",
  informacoes: "informações",
  referencia: "referência",
  historico: "histórico",
  saida: "saída",
  valido: "válido",
  valida: "válida",
  invalido: "inválido",
  aprovacao: "aprovação",
  autorizacao: "autorização",
  operacao: "operação",
  transacao: "transação",
  violao: "violão",
  producao: "produção",
  comissao: "comissão",
  comissoes: "comissões",
  salario: "salário",
  salarios: "salários",
  diaria: "diária",
  diarias: "diárias",
  atras: "atrás",
  nivel: "nível",
  atlantico: "atlântico",
  mae: "mãe",
  ninguem: "ninguém",
  alguem: "alguém",
  propria: "própria",
  proprio: "próprio",
  laco: "laço",
  destinatario: "destinatário",
  destinatarios: "destinatários",
  atencao: "atenção",
  porem: "porém",
  atraves: "através",
  excursao: "excursão",
  alcada: "alçada",
  reimpressao: "reimpressão",
  faco: "faço",
  sessao: "sessão",
  expiracao: "expiração",
  reconciliacao: "reconciliação",
  sandbox: undefined,
};
delete WORDS.sandbox;

/**
 * Bare spellings that are machine values, by file and the exact text matched
 * (case-sensitive). Every entry says why the spelling is load-bearing; a new
 * entry needs the same.
 */
export const ALLOW = [
  { file: "packages/agent-runtime/src/terminal.ts", word: "nao", why: "parseBatchGesture accepts the unaccented answer a person types" },
  { file: "packages/agent-core/src/language.ts", word: "*", why: "detectLanguage's function-word set holds the unaccented spellings people type, next to the accented ones" },
  { file: "agents/checkout-agent/src/pricing.ts", word: "preco", why: "PRICE_FIELDS names the input field the gate refuses; a caller may send it unaccented" },
  { file: "agents/checkout-agent/src/catalog.ts", word: "avaliacao", why: "the catalog's category enum, which list_catalog returns and the cart reads" },
  { file: "agents/supplier-payments-agent/src/payables.ts", word: "comissoes", why: "the batch kind enum, which list_payables returns and a batch ref is built on" },
];

/**
 * Payee aliases, which the mandate names and the code looks up by exact
 * spelling (`escola`, `mercado`, `funcionaria`, `grafica`). Lower-case only:
 * the display names ("Gráfica Litoral") are prose and carry the accent.
 */
export const ALIASES = new Set(["funcionaria", "grafica"]);

const EXTENSIONS = [".ts", ".mjs", ".json", ".jsonl", ".md", ".yaml", ".yml", ".mdc"];
const SCOPES = ["agents", "packages", "skills", "rules", "README.md", "AGENTS.md", "CLAUDE.md"];
const SKIP = /(^|\/)(node_modules|runs|\.codespar)(\/|$)|package-lock\.json$/;
/** Test code is not read by a person; the fixtures it replays are. */
const TEST_CODE = /(^|\/)test\/(?!fixtures\/)/;

function filesOf(root) {
  try {
    return execFileSync("git", ["ls-files", "--", ...SCOPES], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    const out = [];
    const walk = (rel) => {
      const abs = join(root, rel);
      if (!existsSync(abs) || SKIP.test(rel)) return;
      if (statSync(abs).isDirectory()) for (const e of readdirSync(abs)) walk(rel ? `${rel}/${e}` : e);
      else out.push(rel);
    };
    for (const s of SCOPES) walk(s);
    return out;
  }
}

const PATTERN = new RegExp(`(?<![\\p{L}\\p{N}_\\-/@.])(${Object.keys(WORDS).join("|")})(?![\\p{L}\\p{N}_\\-/@])`, "giu");

/**
 * What a person TYPED is theirs, accents or not, and a replay looks a
 * recording up by it: the `input` of a scenario or adversarial turn, the
 * `text` of a scripted conversation turn, and the argument of `--input`.
 * Returns the character ranges of the line that are left alone.
 */
function typedSpans(file, text) {
  const spans = [];
  const quoted = (re) => {
    for (const m of text.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  };
  quoted(/--input\s+("(?:[^"\\]|\\.)*"|'[^']*')/g);
  if (/\.jsonl?$/.test(file)) {
    quoted(/"input"\s*:\s*"(?:[^"\\]|\\.)*"/g);
    if (/\/channels\/whatsapp\/(?!templates\.json)[^/]+\.json$/.test(file)) quoted(/"text"\s*:\s*"(?:[^"\\]|\\.)*"/g);
  }
  return spans;
}

function skipped(file, text, match) {
  const word = match[1];
  if (ALIASES.has(word)) return true;
  if (ALLOW.some((a) => a.file === file && (a.word === "*" || a.word === word))) return true;
  return typedSpans(file, text).some(([a, b]) => match.index >= a && match.index < b);
}

function inScope(file) {
  return !SKIP.test(file) && !TEST_CODE.test(file) && EXTENSIONS.some((e) => file.endsWith(e));
}

/** Every finding under `root`: `{ file, line, word, suggestion, text }`. */
export function scan(root) {
  const findings = [];
  for (const file of filesOf(root)) {
    if (!inScope(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    for (const [i, text] of lines.entries()) {
      for (const m of text.matchAll(PATTERN)) {
        if (skipped(file, text, m)) continue;
        findings.push({ file, line: i + 1, word: m[1], suggestion: accented(m[1]), text: text.trim().slice(0, 160) });
      }
    }
  }
  return findings;
}

/** The accented spelling in the case the word was written in: `nao` -> `não`, `Nao` -> `Não`, `NAO` -> `NÃO`. */
export function accented(word) {
  const target = WORDS[word.toLowerCase()];
  if (word === word.toUpperCase() && word !== word.toLowerCase()) return target.toUpperCase();
  if (word[0] === word[0].toUpperCase()) return target[0].toUpperCase() + target.slice(1);
  return target;
}

/** Rewrites every finding in place. What `scan` would skip, this leaves alone. */
export function fix(root) {
  let changed = 0;
  for (const file of filesOf(root)) {
    if (!inScope(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, "utf8");
    const after = before
      .split("\n")
      .map((text) => text.replace(PATTERN, (...args) => {
        const offset = args[args.length - 2];
        const m = Object.assign([args[0], args[1]], { index: offset });
        return skipped(file, text, m) ? args[0] : accented(args[1]);
      }))
      .join("\n");
    if (after !== before) {
      writeFileSync(abs, after);
      changed += 1;
    }
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = resolve(args.find((a) => !a.startsWith("--")) ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  if (args.includes("--fix")) process.stderr.write(`pt-accents: rewrote ${fix(root)} file(s)\n`);
  const findings = scan(root);
  for (const f of findings) process.stderr.write(`${f.file}:${f.line}: "${f.word}" -> "${f.suggestion}"  ${f.text}\n`);
  process.stderr.write(findings.length ? `pt-accents: ${findings.length} unaccented word(s)\n` : "pt-accents: clean\n");
  process.exit(findings.length ? 1 : 0);
}
