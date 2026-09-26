# CodeSpar Agent Starter Kits

[![ci](https://github.com/codespar/agent-starter-kits/actions/workflows/ci.yml/badge.svg)](https://github.com/codespar/agent-starter-kits/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)](package.json) [![@codespar/cli](https://img.shields.io/npm/v/@codespar/cli?label=%40codespar%2Fcli&color=cb3837&logo=npm)](https://www.npmjs.com/package/@codespar/cli) [![@codespar/mcp](https://img.shields.io/npm/v/@codespar/mcp?label=%40codespar%2Fmcp&color=cb3837&logo=npm)](https://www.npmjs.com/package/@codespar/mcp) [![clone → receipt: 77 s](https://img.shields.io/badge/clone_%E2%86%92_receipt-77_s-8A2BE2)](#quickstart-clone-to-first-receipt)

Agents that move money under a mandate. The person signs the limits once (cap per payment, cap per month, named payees, expiry), the agent proposes payments, and deterministic code decides what actually runs. Every payment ends in an approval record and a receipt.

Four agents ship today, all in TypeScript, all running against the CodeSpar sandbox:

- **[`bills-agent`](agents/bills-agent)** pays a household's monthly bills (school, cleaner, utilities) over Pix.
- **[`collections-agent`](agents/collections-agent)** is the merchant side: it agrees payment terms with a customer, issues a bolepix per instalment and closes the loop when the charge is paid. It is also the one with a second channel: WhatsApp, run against a [local Cloud API emulator](agents/collections-agent#the-whatsapp-channel) that needs no account.
- **[`supplier-payments-agent`](agents/supplier-payments-agent)** is the company side: suppliers, sales commissions and payroll, paid in batches. A batch is a loop of executions, one per line, so a refusal on one payee does not stop the others and re-running it pays nobody twice.
- **[`checkout-agent`](agents/checkout-agent)** sells in the conversation: the customer builds a cart, the code prices it from the catalog, the attendant (or a price and discount policy) confirms the order, and one bolepix is issued when the customer asks to pay. The cart's composition is bound to the approval, so a cart changed after the order was confirmed goes back to the attendant, even at the same total.

A fifth, **[`hello-agent`](agents/hello-agent)**, is the worked example the [`codespar-agent-builder`](skills/codespar-agent-builder) skill builds: read-only, 300 lines, no payment tool at all.

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

**Every run leaves a proof bundle** in `runs/<run-id>/`: transcript, approval artifacts, mandate snapshot, every state transition with who acted, and the receipts. Keys and payee details are masked. `npm run inspect <run-id>` reads it back as a timeline — who proposed what, who approved it under which version of the mandate, which call went out, what the rail answered, which receipts came back — in the terminal, as JSON with `--json`, or as one self-contained HTML page with `--html`.

## What runs today

| | Status |
|---|---|
| Pix payments out (`bills-agent`) | Sandbox |
| Bolepix charges with a sandbox payer (`collections-agent`) | Sandbox |
| WhatsApp as a channel (`collections-agent`, `checkout-agent`) | Against [`dyvit-wa-sim`](https://github.com/fabianocruz/whatsapp-simulator), a local Cloud API emulator: no Meta account, no credential. The CI closes the cycle three times from zero on it |
| WhatsApp through Meta's Cloud API | The same backend, one base URL away. Credentials absent by default; never run against Meta from this repo |
| Batch payouts, one execution per line (`supplier-payments-agent`) | Sandbox |
| A cart priced by code, sold under a price and discount policy, charged by bolepix (`checkout-agent`) | Sandbox |
| Mandate revocation checked against the API before every payment (`bills-agent`) | Live in the sandbox |
| Receipts sealed with HMAC | Proves the payment to whoever runs the agent |
| Receipts also sealed with Ed25519 | Proves the payment to anybody: `npm run verify -- <receipt-file>`. Receipts sealed before the API added it carry none and never will |
| Approval artifacts signed with a local dev key | Stub: the API does not sign approval lists yet |

Not here yet: a WhatsApp run against Meta itself (the adapter is written from the published documentation and this repo has never opened an account). Each agent's README lists its own stubs. [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) tracks every place the code and the spec diverge.

### The two signatures on a receipt

A receipt carries two, and they prove different things to different people.

| Signature | Made with | Proves it to | Checked by |
|---|---|---|---|
| `receipt_sig` | HMAC under the consumer secret CodeSpar holds | Whoever runs the agent. Verifying it means holding the key that also mints it, so to anybody else it is a claim, not evidence | CodeSpar |
| `receipt_sig_ed25519` | Ed25519 under CodeSpar's platform issuer key | Anybody. The public keys are served with no credential at [`/.well-known/codespar-receipt-keys.json`](https://api.codespar.dev/.well-known/codespar-receipt-keys.json) | `npm run verify -- <receipt-file>`, or twenty lines of `node:crypto` |

```sh
npm run verify -- runs/<run-id>/receipts/<receipt-id>.json        # fetches the public keys over HTTPS
npm run verify -- receipt.json --keys codespar-receipt-keys.json # a saved copy: no network at all
npm run verify -- receipt.json --json                            # the verdict as JSON on stdout, the sentence on stderr
npm run verify -- receipt.json --url https://api.staging.codespar.dev/.well-known/codespar-receipt-keys.json
```

The signature covers `codespar-receipt:v1:<receipt_id>:<chain>` and nothing else, so it survives the bundle's masking: a receipt copied off the machine that produced it still verifies, with no key, no API key and no CodeSpar call that could be refused. The answers are kept apart on purpose — `verified`, `tampered`, `unsigned` (sealed before the capability existed, which is not a failure), `unknown_key`, `unreachable` (unknown, never "invalid") and `malformed` — and each has its own exit code. The verifier is [`packages/agent-core/src/receipt-verification.ts`](packages/agent-core/src/receipt-verification.ts): `node:crypto` and nothing else, no SDK, no key material.

Point it at the deployment that sealed the receipt. The default is production; a receipt sealed by another deployment needs its `--url`, because every deployment publishes its own key under the same `kid` and a receipt checked against the wrong set reads `tampered`. [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) §47 has the measurement and the ask.

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
| [`packages/agent-runtime`](packages/agent-runtime) | The runner every agent shares: the terminal channel, `codespar-agent start\|consent\|approve\|deny\|resume\|rerun\|reconcile\|poll\|webhook\|check\|eval\|verify`, and the scenario and adversarial runners. An agent is its files plus one `src/kit.ts`. |
| [`agents/bills-agent`](agents/bills-agent) | Pays bills under a mandate. |
| [`agents/collections-agent`](agents/collections-agent) | Collects from customers inside a negotiation envelope. |
| [`agents/supplier-payments-agent`](agents/supplier-payments-agent) | Pays suppliers, commissions and payroll in batches, under one mandate. |
| [`agents/checkout-agent`](agents/checkout-agent) | Sells from a catalog in the conversation: a cart the code prices, an order the attendant or the policy confirms, one bolepix per order. |
| [`agents/hello-agent`](agents/hello-agent) | The read-only worked example: the smallest agent the runtime can carry. |
| [`skills/codespar-agent-builder`](skills/codespar-agent-builder) | The skill for adding a new agent. |
| [`docs/spec-v5.1.1.md`](docs/spec-v5.1.1.md) | The spec this code was built against. |
| [`AGENTS.md`](AGENTS.md) | Rules for coding agents working in this repo (same file as `CLAUDE.md`). |

## Checks

All run in CI without a model key or a CodeSpar key:

```sh
npm run typecheck                                   # includes a type test: illegal state transitions don't compile
npm run check                                       # plugin manifests, then each agent's prompt/tools/guardrails vs agent.yaml
npm run eval --workspace=agents/bills-agent         # adversarial suite + every scenario in both modes (blocks merge)
npm test                                            # includes the receipt verifier: no network, the key set is injected
node scripts/secret-scan.mjs all                    # also a pre-commit hook
```

## Docs

- [CodeSpar docs](https://codespar.dev/docs)
- [Connect an agent over MCP](https://codespar.dev/docs/mcp)
- [Quickstart](https://codespar.dev/docs/quickstart)

## License

MIT
