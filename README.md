# CodeSpar Agent Starter Kits

[![ci](https://github.com/codespar/agent-starter-kits/actions/workflows/ci.yml/badge.svg)](https://github.com/codespar/agent-starter-kits/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)](package.json) [![@codespar/cli](https://img.shields.io/npm/v/@codespar/cli?label=%40codespar%2Fcli&color=cb3837&logo=npm)](https://www.npmjs.com/package/@codespar/cli) [![@codespar/mcp](https://img.shields.io/npm/v/@codespar/mcp?label=%40codespar%2Fmcp&color=cb3837&logo=npm)](https://www.npmjs.com/package/@codespar/mcp) [![clone → receipt: 77 s](https://img.shields.io/badge/clone_%E2%86%92_receipt-77_s-8A2BE2)](#quickstart-clone-to-first-receipt)

Agents that move money under a mandate. The person signs the limits once (cap per payment, cap per month, named payees, expiry), the agent proposes payments, and deterministic code decides what actually runs. Every payment ends in an approval record and a receipt.

Two agents ship today, both in TypeScript, both running against the CodeSpar sandbox:

- **[`bills-agent`](agents/bills-agent)** pays a household's monthly bills (school, cleaner, utilities) over Pix.
- **[`collections-agent`](agents/collections-agent)** is the merchant side: it agrees payment terms with a customer, issues a bolepix per instalment and closes the loop when the charge is paid.

## Quickstart: clone to first receipt

You need Node 22.13+ and a sandbox key (`csk_test_...`). Get one at [codespar.dev/auth/signup](https://codespar.dev/auth/signup). No money moves.

No Node? [Use this template](https://github.com/codespar/agent-starter-kits/generate) → [Codespaces](https://codespaces.new/codespar/agent-starter-kits?quickstart=1), or open the clone in a devcontainer (`.devcontainer/`); the same commands run inside, with the keys as Codespaces secrets instead of `.env` (see [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md), item 35).

```sh
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
cp agents/bills-agent/.env.example agents/bills-agent/.env   # paste your csk_test_ key
npm install                                                  # at the repo root (npm workspace)
npm run consent -- --yes                                     # sign the mandate once
npm start                                                    # talk to the agent
> pague a escola de outubro
```

The agent drafts the payment, asks you to approve it, pays in the sandbox and prints the receipt path: `recibo: runs/<run-id>/receipts/rcpt_....json`. Our last timed run (staging, 2026-09-23) took 77 seconds from `git clone` to a receipt the API confirmed.

Notes:

- `ANTHROPIC_API_KEY` is optional. Leave it empty and the agent replays a recorded conversation, so you can see the whole flow without a model key.
- Run the consent before `npm start -- --input ...`. The one-shot form refuses to run without a signed mandate; the interactive `npm start` offers the consent on its own.
- Using a staging key? Uncomment `CODESPAR_API_URL=https://api.staging.codespar.dev` in `.env` first.

Check the receipt against the API (key read from `.env`, never printed):

```sh
set -a; . agents/bills-agent/.env; set +a
npx -y @codespar/cli@0.14.0 consumers get-receipts rcpt_...   # expect sandbox: true, money_moved: false
```

Prefer a fresh directory over a clone? `npx -y @codespar/cli@0.14.0 init my-agent --template bills-agent` (or `collections-agent`) scaffolds the same agent.

## How it works

**The model proposes, the code executes.** Model output can only create an execution in `drafted`. Mandate status, payee allowlist, caps, `escalate_above` and the hash of the approved item list are checked in plain code in [`@codespar/agent-core`](packages/agent-core), and only that code moves an execution to `executing`. The adversarial suite plays a model that obeys every attack (prompt injection, payee swap, split payments to dodge a cap) and still passes, because the core refuses.

**One key picks who approves:**

```yaml
approval: human     # the agent assembles, a person approves each payment
approval: mandate   # the agent pays inside the signed limits; escalate_above sends the rest to a person
```

Same code, same states, same receipts. Start with `human`, switch when you trust it.

**Every run leaves a proof bundle** in `runs/<run-id>/`: transcript, approval artifacts, mandate snapshot, every state transition with who acted, and the receipts. Keys and payee details are masked.

## What runs today

| | Status |
|---|---|
| Pix payments out (`bills-agent`) | Sandbox |
| Bolepix charges with a sandbox payer (`collections-agent`) | Sandbox |
| Mandate revocation checked against the API before every payment (`bills-agent`) | Live in the sandbox |
| Receipts sealed with HMAC | Proves the payment to whoever runs the agent |
| Approval artifacts signed with a local dev key | Stub: the API does not sign approval lists yet |

Not here yet: WhatsApp as a channel (terminal only for now), batch payouts, Ed25519-signed receipts. Each agent's README lists its own stubs. [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) tracks every place the code and the spec diverge.

The kits use Pix and bolepix. The CodeSpar API also settles USDC over x402; see the [docs](https://codespar.dev/docs).

## Build your own agent

The repo is also the `codespar-core` plugin: the CodeSpar MCP server (pinned at `@codespar/mcp@0.5.8`) plus the [`codespar-agent-builder`](skills/codespar-agent-builder) skill, which teaches a coding agent to add a new `agents/<name>` with manifest, prompt, tools, guardrails, scenarios and adversarial tests. The MCP reads `CODESPAR_API_KEY` from your shell; the plugin ships no key.

### Install the plugin in your coding agent

| Coding agent | Install |
|---|---|
| Claude Code | `/plugin marketplace add codespar/agent-starter-kits`, then `/plugin install codespar-core@codespar` |
| Codex | `codex plugin marketplace add codespar/agent-starter-kits` |
| Cursor | Dashboard → Plugins & MCPs → Import from Repo |
| Anything else | `npx skills add codespar/agent-starter-kits` |

## Repo layout

| Path | What |
|---|---|
| [`packages/agent-core`](packages/agent-core) | State machine, approval artifact, `agent.yaml` schema, `escalate_above`, local SQLite state, proof bundle, model providers. Every agent builds on it. |
| [`agents/bills-agent`](agents/bills-agent) | Pays bills under a mandate. |
| [`agents/collections-agent`](agents/collections-agent) | Collects from customers inside a negotiation envelope. |
| [`skills/codespar-agent-builder`](skills/codespar-agent-builder) | The skill for adding a new agent. |
| [`docs/spec-v5.1.1.md`](docs/spec-v5.1.1.md) | The spec this code was built against. |
| [`AGENTS.md`](AGENTS.md) | Rules for coding agents working in this repo (same file as `CLAUDE.md`). |

## Checks

All run in CI without a model key or a CodeSpar key:

```sh
npm run typecheck                                   # includes a type test: illegal state transitions don't compile
npm run check                                       # plugin manifests, then each agent's prompt/tools/guardrails vs agent.yaml
npm run eval --workspace=agents/bills-agent         # adversarial suite + every scenario in both modes (blocks merge)
npm test
node scripts/secret-scan.mjs all                    # also a pre-commit hook
```

## Docs

- [CodeSpar docs](https://codespar.dev/docs)
- [Connect an agent over MCP](https://codespar.dev/docs/mcp)
- [Quickstart](https://codespar.dev/docs/quickstart)

## License

MIT
