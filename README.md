# CodeSpar Agent Starter Kits

[![ci](https://github.com/codespar/agent-starter-kits/actions/workflows/ci.yml/badge.svg)](https://github.com/codespar/agent-starter-kits/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)](package.json) [![@codespar/cli](https://img.shields.io/npm/v/@codespar/cli?label=%40codespar%2Fcli&color=cb3837&logo=npm)](https://www.npmjs.com/package/@codespar/cli) [![@codespar/mcp](https://img.shields.io/npm/v/@codespar/mcp?label=%40codespar%2Fmcp&color=cb3837&logo=npm)](https://www.npmjs.com/package/@codespar/mcp) [![clone → receipt: 8 s](https://img.shields.io/badge/clone_%E2%86%92_receipt-8_s-8A2BE2)](#quickstart-clone-to-first-receipt)

Agents that move money under a mandate. The person signs the limits once (cap per payment, cap per month, named payees, expiry), the agent proposes payments, and deterministic code decides what actually runs. Every payment ends in an approval record and a receipt.

Four agents ship today, all in TypeScript, all written against the CodeSpar sandbox. The two that pay run there end to end; the two that issue a bolepix stop at issuance there today (see [What runs today](#what-runs-today)):

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

The agent drafts the payment, asks you to approve it, pays in the sandbox and prints the receipt path: `recibo: runs/<run-id>/receipts/rcpt_....json`. Our last timed run (production test mode, 2026-09-28) took 8 seconds from `git clone` to a receipt the API confirmed. That number starts after signup: it does not count creating the account and the key, it ran with a warm npm cache, and it used the replay model (no `ANTHROPIC_API_KEY`). The run before it, on staging (2026-09-23), took 77 seconds. [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) §12 has both.

Notes:

- `ANTHROPIC_API_KEY` is optional. Leave it empty and the agent replays a recorded conversation, so you can see the whole flow without a model key.
- With a key, the model is `claude-sonnet-5` unless `ANTHROPIC_MODEL` says otherwise. The first two runs with a real model, on production test mode on 2026-09-28, covered the bills-agent and the supplier batch: every receipt verified, no off-script request paid anything, about US$ 0.13 of tokens per run. Two runs are not a distribution; [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) §64 has the table and what they do not prove.
- The agents answer in the language you write in, Brazilian Portuguese or English. The loop reads it from what you type and states it to the model on every step, because a prompt rule alone lost to Portuguese tool results. One real-model run on 2026-09-28 answered 14 cases out of 14 in the input's language, by a function-word heuristic; one run is not a distribution (§64).
- The lines the code prints (the approval question, the batch gesture, the execution lines, the consent summary, the WhatsApp templates) are in the agent's `locale`: `pt-BR` by default, `en` with `locale: en` in `agent.yaml` or `--locale en` on the command. The locale is fixed for a run and for a conversation, so a proposal and its approval are asked in the same language, and it changes only what is shown: `[s/N]` takes `s`, `sim`, `y` and `yes` in both. It is independent of the model's reply language above (§64).
- Run the consent before `npm start -- --input ...`. The one-shot form refuses to run without a signed mandate; the interactive `npm start` offers the consent on its own.
- Using a staging key? Uncomment `CODESPAR_API_URL=https://api.staging.codespar.dev` in `.env` first. The CodeSpar CLI's name for it, `CODESPAR_BASE_URL`, is read too; if both are set they must agree.

Check the receipt against the API (the key and a staging `CODESPAR_API_URL` are read from the agent's `.env`, never printed; an exported variable wins over the file):

```sh
npm run verify -- agents/bills-agent/runs/<run-id>/receipts/rcpt_....json --from-api   # expect VERIFIED, then payment: sandbox true, money_moved false
```

`verify` reads the receipt from the API in memory, checks it and prints the verdict, the chain, the approval and the two payment fields the chain seals. It prints and writes nothing else of the read. Do not print the raw read (`consumers get-receipts`, or `GET /v1/consumers/receipts/{id}` by hand). For a key with the `*` or `mandates:spend` scope, which the signup key has, it still carries `mandate.sig`, the mandate's own HMAC, and that authorizes spends (codespar-enterprise ent#1707).

Prefer a fresh directory over a clone? `npx -y @codespar/cli@0.18.1 init my-agent --template bills-agent` (or `collections-agent`) scaffolds the same agent.

## How it works

**The model proposes, the code executes.** Model output can only create an execution in `drafted`. Mandate status, payee allowlist, caps, `escalate_above` and the hash of the approved item list are checked in plain code in [`@codespar/agent-core`](packages/agent-core), and only that code moves an execution to `executing`. The adversarial suite plays a model that obeys every attack (prompt injection, payee swap, split payments to dodge a cap) and still passes, because the core refuses.

**One key picks who approves:**

```yaml
approval: human     # the agent assembles, a person approves each payment
approval: mandate   # the agent pays inside the signed limits; escalate_above sends the rest to a person
```

Same code, same states, same receipts. Start with `human`, switch when you trust it.

**Every run leaves a proof bundle** in `runs/<run-id>/`: transcript, approval artifacts, mandate snapshot, every state transition with who acted, and the receipts. No API key or secret is written there. The payee's Pix key is masked in the mandate snapshot and in the receipt copies, and is in the clear in `events.jsonl` and `approval.json` ([`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) §37). `npm run inspect <run-id>` is a script of each agent, not of the root: run it inside the agent's folder, or from the root as `npm run inspect --workspace=agents/bills-agent -- <run-id>`. It masks the payee on the way out and reads the bundle back as a timeline — who proposed what, who approved it under which version of the mandate, which call went out, what the rail answered, which receipts came back — in the terminal, as JSON with `--json`, or as one self-contained HTML page with `--html`.

## What runs today

| | Status |
|---|---|
| Pix payments out (`bills-agent`) | Sandbox |
| Bolepix charges with a sandbox payer (`collections-agent`) | The cycle runs on the stub rail and in every scenario. Against the live sandbox no payable bolepix is issued today. On staging the charge ends `ERROR` with no Pix and no boleto, and production test mode refuses it at issuance. The test payer can still settle such a charge, and the read then answers `CONFIRMED` ([ent#1816](https://github.com/codespar/codespar-enterprise/issues/1816)). [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) §22 and §63 have the runs |
| WhatsApp as a channel (`collections-agent`, `checkout-agent`) | Against [`dyvit-wa-sim`](https://github.com/fabianocruz/whatsapp-simulator), a local Cloud API emulator: no Meta account, no credential. The CI closes the cycle three times from zero on it |
| WhatsApp through Meta's Cloud API | The same backend, one base URL away. Credentials absent by default; never run against Meta from this repo |
| Batch payouts, one execution per line (`supplier-payments-agent`) | Sandbox |
| A cart priced by code, sold under a price and discount policy, charged by bolepix (`checkout-agent`) | The cart, the pricing, the policy and the order run everywhere; the charge is the collections-agent's, so against the live sandbox it stops at issuance today, the same way (§63; the test-payer half is [ent#1816](https://github.com/codespar/codespar-enterprise/issues/1816)) |
| Mandate revocation checked against the API before every payment (`bills-agent`) | Live in the sandbox |
| Receipts sealed with HMAC | Proves the payment to whoever runs the agent |
| Receipts also sealed with Ed25519 | Proves the payment to anybody: `npm run verify -- <receipt-file>`. Receipts sealed before the API added it carry none and never will |
| The approved list's hash sealed into the receipt (chain v4) | Every spend carries the approval artifact's `items_hash` (and `batch_hash`); `npm run verify` recomputes the chain from the receipt read and holds that link against the artifact. Proves WHAT was approved, not who |
| Approval artifacts signed with a local dev key | Stub: the API does not sign approval lists, so WHO approved is proved to whoever runs the agent only |

Not here yet: a WhatsApp run against Meta itself (the adapter is written from the published documentation and this repo has never opened an account). Each agent's README lists its own stubs. [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) tracks every place the code and the spec diverge.

### The two signatures on a receipt

A receipt carries two, and they prove different things to different people.

| Signature | Made with | Proves it to | Checked by |
|---|---|---|---|
| `receipt_sig` | HMAC under the consumer secret CodeSpar holds | Whoever runs the agent. Verifying it means holding the key that also mints it, so to anybody else it is a claim, not evidence | CodeSpar |
| `receipt_sig_ed25519` | Ed25519 under CodeSpar's platform issuer key | Anybody. The public keys are served with no credential at [`/.well-known/codespar-receipt-keys.json`](https://api.codespar.dev/.well-known/codespar-receipt-keys.json) | `npm run verify -- <receipt-file>`, or twenty lines of `node:crypto` |

```sh
npm run verify -- receipt-read.json --approval approval.json      # the API's read: signature, body and approved list, no credential
npm run verify -- runs/<run-id>/receipts/<receipt-id>.json        # a run's masked copy: the signature only
npm run verify -- runs/<run-id>/receipts/<receipt-id>.json --from-api  # the copy, bound through the API's read (the tenant's key; nothing written)
npm run verify -- receipt.json --keys codespar-receipt-keys.json # a saved copy of the key set: no network at all
npm run verify -- receipt.json --json                            # the verdict as JSON on stdout, the sentence on stderr
npm run verify -- receipt.json --url https://api.staging.codespar.dev/.well-known/codespar-receipt-keys.json
```

`receipt-read.json` is the API's read as a tenant hands it to somebody else, and it goes without `mandate.sig`. A v4 chain seals only its hash, so the verifier never needs the signature, and whoever holds it can spend under the mandate (§47).

The signature covers `codespar-receipt:v1:<receipt_id>:<chain>` and nothing else, so it survives the bundle's masking: a receipt copied off the machine that produced it still verifies, with no key, no API key and no CodeSpar call that could be refused. The body is another matter. The chain is a digest of the receipt's links (mandate, quote with the payee, approval, payment), and the key document publishes how to recompute it (`chain_recipe`). From the API's receipt read, `verify` recomputes it, holds it against the signed chain, and for a v4 receipt holds the sealed approval hashes against the approval artifact: that is "this payment was made against the list H". The bundle's copy masks the payee the chain sealed, so it proves the signature only, unless `--from-api` reads the unmasked receipt from the API at verify time. The answers are kept apart on purpose — `verified` (signature, body and, when an artifact is given, approval), `signature_only` (the body could not be bound: a masked copy, a v1–v3 chain, no recipe; not a failure), `chain_mismatch`, `approval_mismatch`, `tampered`, `unsigned` (sealed before the capability existed, which is not a failure), `unknown_key`, `unreachable` (unknown, never "invalid") and `malformed` — and each has its own exit code. The verifier is [`packages/agent-core/src/receipt-verification.ts`](packages/agent-core/src/receipt-verification.ts) and [`receipt-chain.ts`](packages/agent-core/src/receipt-chain.ts): `node:crypto` and nothing else, RFC 8785 included, no SDK, no key material.

Point it at the deployment that sealed the receipt. The default is production; a receipt sealed by another deployment needs its `--url` (with `--from-api`, the key set defaults to the API's own deployment). The recipe is read from the same document whose key verified the signature. [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) §47 has the measurements and the decisions, §3 what the approval link does and does not prove.

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
