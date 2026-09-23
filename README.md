# CodeSpar Agent Starter Kits

Agents that pay under a mandate, with approval and a receipt. Clone, add one key, sign the mandate once, talk to an agent in the terminal.

```
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
cp agents/bills-agent/.env.example agents/bills-agent/.env   # set CODESPAR_API_KEY (csk_test_...); leave ANTHROPIC_API_KEY empty to replay
npm install && npm run consent -- --yes                      # at the repository root (npm workspace); signs the mandate once
npm start                                                    # or one turn: npm start -- --input "pague a escola de outubro" --approve
> pague a escola de outubro
```

The consent comes first: `npm start -- --input ...` refuses to run without a signed mandate (`no signed mandate yet`), and the interactive `npm start` offers the consent itself when a test key is present. A staging test key also needs `CODESPAR_API_URL=https://api.staging.codespar.dev` in that `.env` before the consent (the line is there, commented). A production key needs nothing else. `ANTHROPIC_API_KEY` may stay empty: without a real key the kit replays the recorded happy path, and the old placeholder `sk-ant-your_key_here` counts as empty.

The run prints the receipt as `recibo: runs/<run-id>/receipts/rcpt_....json`. To confirm it against the API, with the key from `.env` and never on the screen (a staging key also needs `--base-url "$CODESPAR_API_URL"`):

```
set -a; . agents/bills-agent/.env; set +a
npx -y @codespar/cli@0.13.0 consumers get-receipts rcpt_...   # GET /v1/consumers/receipts/{id}; expect sandbox: true, money_moved: false
```

Measured on 2026-09-23 in staging, context-free run following only the README, no retry: 77 s from `git clone` to a receipt the API answered with 200. 27 of those seconds were a first `npm start -- --input` refused for lack of a mandate, which is why the consent is a line of the path above; the path as now written has not been re-timed.

## What is here

| Path | What |
|---|---|
| [`packages/agent-core`](packages/agent-core) | `@codespar/agent-core`: the execution state machine, the approval artifact, the `agent.yaml` schema, `escalate_above`, `actor`, local state (SQLite), the proof bundle, the providers. Every agent inherits it. |
| [`agents/bills-agent`](agents/bills-agent) | The anchor agent. The titular delegates the month's bills under a mandate: cap per payment, cap per month, named payees, expiry. Every payment returns a receipt. |
| [`agents/collections-agent`](agents/collections-agent) | The merchant's agent that collects. Agrees terms with the payer inside a negotiation envelope, issues one bolepix per instalment with an idempotency key, shows the QR in the conversation, and closes the cycle on `commerce.charge.paid` or `commerce.charge.expired`, by poll or by webhook. The sandbox payer plays the debtor. |
| [`docs/spec-v5.1.1.md`](docs/spec-v5.1.1.md) | The spec this wave was built against. |
| [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) | Where the spec and the API diverged, what the code does, what is a stub. Input for v5.2. |
| [`skills/codespar-agent-builder`](skills/codespar-agent-builder) | The skill that teaches a coding agent to add `agents/<name>`: anatomy, `agent.yaml`, prompt, tools, guardrails, scenarios, adversarial cases, gates. Proven by `hello-agent` (docs/OPEN_QUESTIONS.md, item 33). |
| `.claude-plugin/`, `.cursor-plugin/`, `.agents/plugins/`, `plugin.json`, `mcp.json`, `rules/` | The `codespar-core` plugin (section 14.1): the pinned CodeSpar MCP plus the skill, one manifest per coding agent. See [Install the plugin](#install-the-plugin-in-your-coding-agent). |
| [`AGENTS.md`](AGENTS.md) (= `CLAUDE.md`) | The rules for a coding agent working anywhere in this tree; each agent adds its own. |

## Install the plugin in your coding agent

The repository is also the `codespar-core` plugin: the CodeSpar MCP pinned at `@codespar/mcp@0.5.8` (`mcp.json`) plus the `codespar-agent-builder` skill (`skills/`). One install gives a coding agent the API and the procedure to build the fourth agent. The MCP reads `CODESPAR_API_KEY` from your shell; the plugin ships no key.

| Coding agent | Reads | Install |
|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json` | `/plugin marketplace add codespar/agent-starter-kits`, then `/plugin install codespar-core@codespar` |
| Codex | `.agents/plugins/marketplace.json`, `plugin.json` (Agent Plugins standard), `mcp.json` | `codex plugin marketplace add codespar/agent-starter-kits` |
| Cursor | `.cursor-plugin/plugin.json`, `skills/`, `rules/`, `mcp.json` | Dashboard → Plugins & MCPs → Import from Repo, or Customize → Install |
| Any other | `skills/codespar-agent-builder/SKILL.md` | `npx skills add codespar/agent-starter-kits` |

`npm run check` validates the manifests before the agents: JSON that parses, every referenced path present, the skill's frontmatter, the MCP pin equal to the one in `agents/bills-agent/agent.yaml`, and the root `AGENTS.md` equal to `CLAUDE.md`.

## The one rule

The model proposes, the code executes. A model output can create an execution in `drafted` and nothing else. Mandate, allowlist, caps, `escalate_above` and the `items_hash` of the approved list are checked in deterministic code, and only that code reaches `executing`. The adversarial suite in `agents/bills-agent/evals/adversarial/` plays a model that complies with every attack, and passes because the core does not.

## The `approval` key

```
approval: human     the agent assembles; the titular approves each one; the approved list is attested
approval: mandate   the agent executes inside the signed allowance; escalate_above sends the rest to a human
```

Same code, same trail, same receipts. Start in `human`; flip the key when the client trusts it.

## Gates (all run in the CI without a model or a CodeSpar key)

- `npm run typecheck`: includes a type test proving a transition outside the table does not compile.
- `npm run check`: the plugin manifests first (`scripts/check-plugin.mjs`), then, for every agent, the manifest is the index; the prompt, tools and guardrails must agree with it.
- `npm run eval --workspace=agents/<name>`: adversarial suite plus every scenario in every mode, on the replay provider. Blocks merge. Both agents.
- `npm test`: the core, the restart-in-`executing`-then-`resume` test, `rerun`, `approve`/`deny`, and `--json` output. When piping `npm start -- --input ... --json`, add npm's `-s`: npm prints the script banner on stdout, the kit does not.
- `node scripts/secret-scan.mjs all`: no key-shaped string in the tree. Also a pre-commit hook.

Requires Node 22 or newer (`engines` says 22.13, the `node:sqlite` floor, no native build; the measured run used 25.5).

## The same, through the CLI

`agent.yaml` pins `cli: "@codespar/cli@0.13.0"`, the version whose help these lines match. The `npm` scripts stay as shortcuts.

```
npx -y @codespar/cli@0.13.0 agent run agents/bills-agent --input "pague a escola de outubro" --approve
npx -y @codespar/cli@0.13.0 eval agents/bills-agent
npx -y @codespar/cli@0.13.0 mandate revoke <mandate-id> --reason "cancelled by the titular"
```

`agent run` drives the agent's own `npm start` (without `--input`, the interactive terminal); `eval` runs `npm run check` plus the adversarial suite and the scenarios; `mandate revoke` is the section 4.7 kill switch for one mandate, against the API.

## What is sandbox, what is a stub

Everything runs in the CodeSpar sandbox with a `csk_test_` key; any other key is refused before a network call. With a test key, the revocation check of section 4.7 is real: before `executing` the core reads the mandate's status from the API (`GET /v1/mandates/{id}`) and executes on `active` only; `paused`, `revoked` and `expired` refuse, and a read that does not answer refuses too (`mandate_status_unavailable`), never "assume active". Two pieces are local stubs, marked in code and in the READMEs: the signature of the approval artifact (a local dev key; the API does not sign approval lists) and, for runs without a key (the CI, the scenarios), the status source over the local state.db, which also carries the organization kill switch (`org pauseAll`) the API does not expose yet. The receipt seal is HMAC; it proves the payment to whoever runs the agent, and to nobody else until Ed25519. On the receiving side (`collections-agent`) the collection policy has no API-side status to read, so its revocation source is the local stub in both rails; the payer is the sandbox route `POST /v1/test/charges/{id}/pay`, test environment only, and the API seals no record for a paid charge; the webhook receiver is a documented stub and the poll is the default.

## Protocols

| Protocol | Whose | Relation to CodeSpar today |
|---|---|---|
| x402 | x402 Foundation, from Coinbase | In use: USDC over x402. |
| AP2 | Google | Not supported. Candidate to map the CodeSpar mandate onto. |
| Visa Intelligent Commerce | Visa | Not supported. Cards are outside CodeSpar's rails today. |
| ACP | OpenAI, in ChatGPT | Not supported. |
| UCP | Google, in AI Mode and Gemini | Not supported. |

None of these lines promises Pix on those protocols.

## License

MIT.
