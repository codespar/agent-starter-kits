#!/usr/bin/env node
// `npm run check`, plugin half: the manifests of section 14.1 parse, name the
// same plugin, reference only files that exist, and the skills they ship carry
// the frontmatter a coding agent needs. Runs in the CI with no key and no
// network. Exit 1 on any finding.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLUGIN_NAME = "codespar-core";
const MANIFESTS = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".cursor-plugin/plugin.json", "plugin.json", "mcp.json", ".mcp.json", ".agents/plugins/marketplace.json"];
const SKILLS_DIR = "skills";
const RULES_DIR = "rules";
const AGENTS_MD = "AGENTS.md";
const CLAUDE_MD = "CLAUDE.md";

/** A string value inside a manifest that looks like a repository path: `./x`, `x/y.ext`, or a bare `NAME.md`. */
const PATH_LIKE = /^(\.\/[^\s]*|[A-Za-z0-9_.-]+\/[^\s]*|[A-Za-z0-9_.-]+\.(md|json|mdc))$/;
const URL_LIKE = /^[a-z]+:/i;

export function checkPlugin(root = ROOT) {
  const findings = [];
  const error = (code, message) => findings.push({ level: "error", code, message });
  const read = (rel) => readFileSync(join(root, rel), "utf8");

  const docs = {};
  for (const rel of MANIFESTS) {
    if (!existsSync(join(root, rel))) {
      error("manifest_missing", `${rel} does not exist`);
      continue;
    }
    try {
      docs[rel] = JSON.parse(read(rel));
    } catch (err) {
      error("manifest_unparseable", `${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Every path-like string in every manifest resolves inside the repository.
  for (const [rel, doc] of Object.entries(docs)) {
    for (const [where, value] of stringLeaves(doc)) {
      if (URL_LIKE.test(value) || !PATH_LIKE.test(value)) continue;
      if (value.startsWith("../") || value.includes("/../")) error("manifest_path_escapes", `${rel} ${where}: ${value} leaves the repository`);
      else if (!existsSync(join(root, value))) error("manifest_path_missing", `${rel} ${where}: ${value} does not exist`);
    }
  }

  // The plugin has one name across the four tools, and the marketplaces point at this repository.
  for (const rel of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", "plugin.json"]) {
    const doc = docs[rel];
    if (doc && doc.name !== PLUGIN_NAME) error("manifest_name", `${rel} names ${JSON.stringify(doc.name)}, expected ${PLUGIN_NAME}`);
  }
  const claudeMarket = docs[".claude-plugin/marketplace.json"];
  if (claudeMarket) {
    if (typeof claudeMarket.name !== "string" || !claudeMarket.owner?.name) error("marketplace_invalid", ".claude-plugin/marketplace.json needs `name` and `owner.name`");
    const entry = (claudeMarket.plugins ?? []).find((p) => p?.name === PLUGIN_NAME);
    if (!entry) error("marketplace_entry_missing", `.claude-plugin/marketplace.json lists no plugin named ${PLUGIN_NAME}`);
    else if (entry.source !== "./") error("marketplace_source", `.claude-plugin/marketplace.json: ${PLUGIN_NAME} must load from "./" (the repository is the plugin)`);
  }
  const codexMarket = docs[".agents/plugins/marketplace.json"];
  if (codexMarket) {
    if (typeof codexMarket.name !== "string") error("marketplace_invalid", ".agents/plugins/marketplace.json needs `name`");
    const entry = (codexMarket.plugins ?? []).find((p) => p?.name === PLUGIN_NAME);
    if (!entry) error("marketplace_entry_missing", `.agents/plugins/marketplace.json lists no plugin named ${PLUGIN_NAME}`);
    else if (entry.source?.source !== "local" || entry.source?.path !== "./") error("marketplace_source", `.agents/plugins/marketplace.json: ${PLUGIN_NAME} must be { source: "local", path: "./" }`);
  }
  const standard = docs["plugin.json"];
  if (standard && typeof standard.$schema !== "string") error("manifest_invalid", "plugin.json (Agent Plugins standard) needs `$schema`");
  const claudePlugin = docs[".claude-plugin/plugin.json"];
  if (claudePlugin && claudePlugin.skills !== undefined && !String(claudePlugin.skills).startsWith(`./${SKILLS_DIR}`)) error("manifest_skills", `.claude-plugin/plugin.json must point skills at ./${SKILLS_DIR}/`);

  // The MCP is the pinned one, and the pin is the manifest's. Two spellings of one file: `mcp.json` is the Agent
  // Plugins standard (Codex, Cursor); `.mcp.json` is the default Claude Code loads (measured 2026-09-23: neither the
  // `mcpServers` path field nor an inline object registered the server; the dotfile did).
  if (docs["mcp.json"] && docs[".mcp.json"] && read("mcp.json") !== read(".mcp.json")) error("mcp_split", "mcp.json and .mcp.json differ; they are the same file spelled for two loaders");
  const mcp = docs["mcp.json"];
  if (mcp) {
    const servers = mcp.mcpServers;
    if (!servers || typeof servers !== "object" || Object.keys(servers).length === 0) error("mcp_invalid", "mcp.json needs a non-empty `mcpServers`");
    else {
      const pin = manifestMcpPin(root);
      for (const [name, server] of Object.entries(servers)) {
        const args = Array.isArray(server?.args) ? server.args : [];
        const named = args.find((a) => typeof a === "string" && a.startsWith("@codespar/mcp"));
        if (!named) error("mcp_unpinned", `mcp.json server ${name} does not run @codespar/mcp`);
        else if (!/^@codespar\/mcp@\d+\.\d+\.\d+$/.test(named)) error("mcp_unpinned", `mcp.json server ${name} must pin an exact version, got ${named}`);
        else if (pin && named !== pin) error("mcp_pin_drift", `mcp.json runs ${named}; agents/bills-agent/agent.yaml pins ${pin}`);
        if (server?.env && Object.values(server.env).some((v) => /csk_(live|test)_(?!your_key_here)/.test(String(v)))) error("mcp_secret", `mcp.json server ${name} carries a key; the key comes from the environment`);
      }
    }
  }

  // Skills: `skills/<name>/SKILL.md` with frontmatter `name` (== directory) and `description`; every relative link resolves.
  const skillsRoot = join(root, SKILLS_DIR);
  if (!existsSync(skillsRoot)) error("skills_missing", `${SKILLS_DIR}/ does not exist`);
  else {
    const dirs = readdirSync(skillsRoot).filter((d) => statSync(join(skillsRoot, d)).isDirectory());
    if (dirs.length === 0) error("skills_empty", `${SKILLS_DIR}/ holds no skill`);
    for (const dir of dirs) {
      const rel = `${SKILLS_DIR}/${dir}/SKILL.md`;
      if (!existsSync(join(root, rel))) {
        error("skill_missing", `${rel} does not exist`);
        continue;
      }
      const text = read(rel);
      const fm = frontmatter(text);
      if (!fm) {
        error("skill_frontmatter_missing", `${rel} has no YAML frontmatter`);
        continue;
      }
      if (fm.name !== dir) error("skill_name", `${rel} frontmatter name is ${JSON.stringify(fm.name)}, expected ${dir}`);
      if (!fm.description || fm.description.length < 20) error("skill_description", `${rel} frontmatter needs a description that says when to use it`);
      for (const [file, target] of skillReferences(root, `${SKILLS_DIR}/${dir}`)) {
        if (!existsSync(join(root, target))) error("skill_reference_missing", `${file} references ${target}, which does not exist`);
      }
    }
    if (!dirs.includes("codespar-agent-builder")) error("skill_missing", `${SKILLS_DIR}/codespar-agent-builder is the skill the plugin ships`);
  }

  // Rules (Cursor) and the root AGENTS.md the plugin points at.
  if (!existsSync(join(root, RULES_DIR))) error("rules_missing", `${RULES_DIR}/ does not exist`);
  else {
    for (const file of readdirSync(join(root, RULES_DIR)).filter((f) => f.endsWith(".mdc"))) {
      const rel = `${RULES_DIR}/${file}`;
      if (!frontmatter(read(rel))) error("rule_frontmatter_missing", `${rel} has no YAML frontmatter`);
      for (const [f, target] of markdownPaths(root, rel)) if (!existsSync(join(root, target))) error("rule_reference_missing", `${f} references ${target}, which does not exist`);
    }
  }
  if (!existsSync(join(root, AGENTS_MD))) error("agents_md_missing", `${AGENTS_MD} does not exist at the repository root`);
  if (!existsSync(join(root, CLAUDE_MD))) error("claude_md_missing", `${CLAUDE_MD} does not exist at the repository root`);
  if (existsSync(join(root, AGENTS_MD)) && existsSync(join(root, CLAUDE_MD)) && read(AGENTS_MD) !== read(CLAUDE_MD)) error("agents_md_diverges", `${AGENTS_MD} and ${CLAUDE_MD} differ at the repository root`);

  return { ok: findings.every((f) => f.level !== "error"), findings };
}

function* stringLeaves(value, where = "$") {
  if (typeof value === "string") yield [where, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* stringLeaves(v, `${where}[${i}]`);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* stringLeaves(v, `${where}.${k}`);
}

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return undefined;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function manifestMcpPin(root) {
  const path = join(root, "agents", "bills-agent", "agent.yaml");
  if (!existsSync(path)) return undefined;
  const m = /^mcp:\s*"?(@codespar\/mcp@\d+\.\d+\.\d+)"?/m.exec(readFileSync(path, "utf8"));
  return m?.[1];
}

/** Every repository path a skill's markdown names: `[text](relative.md)` links resolve against the file, `agents/x/y`-style code spans against the root. */
function* skillReferences(root, skillDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (entry.endsWith(".md")) files.push(rel);
    }
  };
  walk(skillDir);
  for (const file of files) yield* markdownPaths(root, file);
}

function* markdownPaths(root, file) {
  const text = readFileSync(join(root, file), "utf8");
  const dir = dirname(file);
  for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = m[1];
    if (URL_LIKE.test(target)) continue;
    yield [file, normalize(join(dir, target))];
  }
  for (const m of text.matchAll(/`((?:agents|packages|docs|scripts|skills)\/[A-Za-z0-9_./-]+)`/g)) {
    const target = m[1].replace(/\/$/, "");
    if (/[<>*]/.test(target)) continue;
    yield [file, target];
  }
}

function normalize(p) {
  return p.split("/").reduce((acc, seg) => {
    if (seg === "..") acc.pop();
    else if (seg !== ".") acc.push(seg);
    return acc;
  }, []).join("/");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes("--json");
  const report = checkPlugin();
  if (json) process.stdout.write(JSON.stringify(report) + "\n");
  for (const f of report.findings) process.stderr.write(`${f.level === "error" ? "ERROR" : "warn "} ${f.code}: ${f.message}\n`);
  process.stderr.write(report.ok ? "check ok: the plugin manifests, the skills and the rules agree\n" : "check FAILED for the plugin manifests\n");
  process.exit(report.ok ? 0 : 1);
}
