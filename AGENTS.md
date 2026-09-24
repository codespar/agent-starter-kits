# Rules for the coding agent working in this repository

This is `codespar/agent-starter-kits`: agents that pay under a mandate, with
approval and a receipt, on top of `@codespar/agent-core`. These rules apply to
the whole tree; each agent under `agents/` adds its own `AGENTS.md`.

1. **Read before editing.** `agents/<name>/agent.yaml` is the index of an
   agent; `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` and
   `mandate.example.json` must agree with it, and `npm run check` fails when
   they do not. `packages/agent-core/README.md` says what the core proves.
2. **To create an agent, use the skill.** `skills/codespar-agent-builder/SKILL.md`
   is the procedure: anatomy, manifest, prompt, tools, guardrails, scenarios,
   adversarial cases, gates. Do not improvise a fourth layout.
3. **The model proposes, the code executes.** A model output creates an
   execution in `drafted` and nothing else; only `ExecutionEngine` reaches
   `executing`. A new check goes in the core or in a `policyExtension`, never
   in a prompt.
4. **Do not widen `tools.json` or a mandate without asking.** The tool list is
   closed on purpose; caps and payees are the person's. Adding a tool or a
   payee is a product decision.
5. **`escalate_above` only tightens.** A trigger may send an execution to a
   human; it may never raise a cap or add a payee.
6. **`actor` on everything.** Every event, approval and receipt copy carries
   who acted.
7. **Sandbox by construction.** Only `csk_test_` keys. Never commit `.env`,
   `.codespar/` or `runs/`. `node scripts/secret-scan.mjs` runs on every
   commit and on the whole tree in the CI.
8. **Pins are exact.** `agent.yaml` pins `mcp:` and `cli:` to one published
   version each; the plugin's `mcp.json` pins the same MCP. Updating a pin is
   its own PR with the suite green.
9. **Before you say a task is done:** `npm run check` (every agent plus the
   plugin manifests), `npm run eval --workspace=agents/<name>`, `npm run
   typecheck`, `npm test`. All green, or it is not done.
10. **Use the CodeSpar MCP and skills** (`mcp.json`, `@codespar/mcp@0.5.8`)
    to learn the real API. When `docs/spec-v5.1.1.md` and the API diverge,
    follow the API and log it in `docs/OPEN_QUESTIONS.md`.
11. **Say which signature you mean.** A receipt sealed since the API added
    Ed25519 carries a signature anybody can check against the published key
    set, with no credential — that is what `npm run verify -- <receipt-file>`
    does. "Verifiable by a third party" is true of THAT and of nothing else
    here: a receipt sealed before the change carries no Ed25519 signature and
    never will, and the approval artifact is still HMAC with a local
    development key. Write the phrase only where `Ed25519` is written too;
    `npm run check` fails otherwise.
12. **No telemetry.** Nothing in this repository phones home.

`AGENTS.md` and `CLAUDE.md` are the same file, here and in every agent; `npm
run check` fails if they diverge. Edit both or neither.
