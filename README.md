# CodeSpar Agent Starter Kits

Agents that pay under a mandate, with approval and a receipt. Clone, add two keys, talk to an agent in the terminal in five minutes.

```
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
cp agents/bills-agent/.env.example agents/bills-agent/.env   # CODESPAR_API_KEY (csk_test_...) and ANTHROPIC_API_KEY
npm install && npm start                                     # at the repository root: it is an npm workspace
> pague a escola de outubro
```

A staging test key also needs `CODESPAR_API_URL=https://api.staging.codespar.dev` in that `.env` (the line is there, commented). A production key needs nothing else.

## What is here

| Path | What |
|---|---|
| [`packages/agent-core`](packages/agent-core) | `@codespar/agent-core`: the execution state machine, the approval artifact, the `agent.yaml` schema, `escalate_above`, `actor`, local state (SQLite), the proof bundle, the providers. Every agent inherits it. |
| [`agents/bills-agent`](agents/bills-agent) | The anchor agent. The titular delegates the month's bills under a mandate: cap per payment, cap per month, named payees, expiry. Every payment returns a receipt. |
| [`agents/collections-agent`](agents/collections-agent) | The merchant's agent that collects. Agrees terms with the payer inside a negotiation envelope, issues one bolepix per instalment with an idempotency key, shows the QR in the conversation, and closes the cycle on `commerce.charge.paid` or `commerce.charge.expired`, by poll or by webhook. The sandbox payer plays the debtor. |
| [`docs/spec-v5.1.1.md`](docs/spec-v5.1.1.md) | The spec this wave was built against. |
| [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) | Where the spec and the API diverged, what the code does, what is a stub. Input for v5.2. |

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
- `npm run check`: for every agent, the manifest is the index; the prompt, tools and guardrails must agree with it.
- `npm run eval --workspace=agents/<name>`: adversarial suite plus every scenario in every mode, on the replay provider. Blocks merge. Both agents.
- `npm test`: the core, the restart-in-`executing`-then-`resume` test, `rerun`, `approve`/`deny`, and `--json` output. When piping `npm start -- --input ... --json`, add npm's `-s`: npm prints the script banner on stdout, the kit does not.
- `node scripts/secret-scan.mjs all`: no key-shaped string in the tree. Also a pre-commit hook.

Requires Node 22.13 or newer (`node:sqlite`, no native build).

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
