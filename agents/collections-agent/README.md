# collections-agent

[![rail: bolepix](https://img.shields.io/badge/rail-bolepix-2E8B57)](agent.yaml) [![maturity: sandbox](https://img.shields.io/badge/maturity-sandbox-orange)](agent.yaml) [![approval: human | mandate](https://img.shields.io/badge/approval-human_%7C_mandate-555)](agent.yaml) [![charge → settled: 10 s](https://img.shields.io/badge/charge_%E2%86%92_settled-10_s-8A2BE2)](#quickstart)

The merchant's collections agent. A customer replies about an open debt; the agent proposes terms inside a negotiation envelope (maximum discount, number of instalments, due-date window, collection hours), and once the customer accepts, the code issues one bolepix per instalment, shows the QR code and the copy-and-paste Pix code in the chat, and closes the loop when the charge is paid or expires. Terminal for now; WhatsApp later.

## Quickstart

Node 22.13+ and a sandbox key (`csk_test_...`) from [codespar.dev/auth/signup](https://codespar.dev/auth/signup). No money moves: a sandbox payer plays the customer's bank.

```sh
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
cp agents/collections-agent/.env.example agents/collections-agent/.env   # paste your csk_test_ key
npm install                                                              # at the repo root (npm workspace)
npm run start:collections
pagador> oi, recebi a mensagem sobre o acordo do pedido 1042
```

You type as the customer. In `human` mode the operator's approval is asked on the same keyboard, labelled `[operador]`. Without a real `ANTHROPIC_API_KEY` (empty or the `.env.example` placeholder) the agent replays the recorded scenario.

Scaffold instead of cloning: `npx -y @codespar/cli@0.14.0 init my-agent --template collections-agent`.

## What it shows

| Contract | How |
|---|---|
| The model proposes, the code executes | `codespar_charge` creates an execution in `drafted`. Only `ExecutionEngine` in `@codespar/agent-core` checks the collection policy (debtors' book, cap per receivable, window cap), the envelope, `escalate_above` and `items_hash`, and only it reaches `executing`. |
| The envelope is code, not prompt | `guardrails.envelope` is the `policyExtension` the core runs at every gate: a discount above the ceiling, more instalments than allowed, a due date outside the window or a message outside collection hours is `denied` with reason `outside_envelope` or `outside_hours`, in both modes, whatever anyone typed. |
| One receivable per instalment, once | Each instalment is one `POST /v1/charges` (`method: boleto` + `due_date`, the cobranca com vencimento the payer settles by Pix or boleto) with `idempotency_key` = the attempt id. A retry returns the same charge. `GET /v1/charges/{id}` accepts that key, which is what lets a restart find the charge instead of issuing again. |
| The cycle closes on the state machine | An accepted receivable leaves the execution in `executing` with reason `awaiting_settlement`. `commerce.charge.paid` moves it to `settled`; `expired` and `cancelled` to `failed` with that reason. Duplicate events are dropped by id; `paid` after `expired`, or the reverse, moves nothing; the payer is told once. |
| Two modes, one envelope | `approval: human` (default): the operator approves each issuance. `approval: mandate`: the agent issues alone inside the envelope and asks the operator above R$ 3.000,00. Same code, same states, same records. |
| Readable refusal | Discount, instalments, due date, hours, cap, unknown debtor, revoked policy: each names itself in the trail and in the chat. |
| Survives a restart | Kill the process after the issuance, run `npm run resume` then `npm run poll`: one charge, one settlement. |
| Sandbox by construction | A key that does not start with `csk_test_` fails before any network call. The sandbox payer is a test-environment route the API refuses to a live key. |

## How the loop closes: poll, and a webhook when you have one

The API delivers `commerce.charge.*` through triggers to a URL. A terminal has none, so the kit's default is to LOOK: `GET /v1/charges/{id}` every three seconds (the stub's fixture, offline) through the core's `reconcile`, which is read-only on the rail and never re-issues. The first look that finds the instrument payable prints the QR (as an image, in the terminal) with the copy-and-paste under it; the look that finds it paid or expired closes the execution and tells the payer once. `npm run poll` continues after a restart or a timeout; nothing shown twice, nothing said twice, because both marks live in `state.db`.

`channels/webhook/` is the other closer, a documented stub: the receiving contract of a trigger delivery (`X-CodeSpar-Signature: t=..,v1=..`, body `{ id, type, data: { payment_id } }`), signature verification with the trigger's secret, dedup by event id, and `npm run webhook` to run it on localhost. Registering the trigger and exposing the URL are the developer's steps (`codespar triggers create`). See `docs/OPEN_QUESTIONS.md` section 21.

## The sandbox payer

With a test key, the debtor is `POST /v1/test/charges/{chargeId}/pay` (alias `POST /v1/charges/{chargeId}/sandbox/pay`): the charge goes through the same settlement path a provider `charge-in` webhook takes, `commerce.charge.paid` fans out to the project's triggers, and every record carries `simulated: true` and `settled_against: "sandbox_fixture"`. No money moves anywhere. The kit calls it only when a scenario says `payer: pays` or you pass `--simulate-payer`. In the CI the payer is the fixture inside the stub rail (`packages/agent-core/src/stubs/charge-rail.ts`).

## What is sandbox, what the agent applies alone, what is out

Read from `agent.yaml`, field `maturity`:

| Capability | Maturity | Meaning |
|---|---|---|
| `bolepix-receivables` | sandbox | Cobranca com vencimento through the CodeSpar sandbox, paid by the sandbox payer. No real money. |
| `receipt-verification` | blocked | Waits for Ed25519; and the API seals no record for a paid charge today (the paid charge as the API reports it is what the bundle keeps, marked `kind: "charge"`, unsealed). |

What the agent applies on its own (`guardrails.json`): the envelope (15% maximum discount, up to 3 instalments, due dates within 90 days, R$ 50,00 minimum instalment, collection hours 08:00–20:00 in America/Sao_Paulo), the escalation threshold (R$ 3.000,00 per agreement in `mandate`), and "the core's total wins" when the model states another.

Not in this kit yet: WhatsApp, a policy signed by the API for the receiving side (section 16 of the spec, candidate to product), `npm run inspect`.

## Commands

| Command | Does |
|---|---|
| `npm start` | Interactive terminal. You are the payer; the operator's approval is asked on the same keyboard. |
| `npm start -- --input "oi, recebi a mensagem sobre o acordo do pedido 1042" [--approve] [--simulate-payer] [--wait 60] [--json] [--now <ISO>]` | One turn, no prompt. Without `ANTHROPIC_API_KEY` it replays the recorded scenario whose first turn is that input. `--json`: machine data on stdout, people on stderr (add npm's `-s` when piping). Exit code 3 when a receivable is still waiting. `--now 2026-09-23T14:00:00-03:00` pins the clock the guardrails read (collection hours `08:00-20:00`, the due-date window, every timestamp) instead of the wall clock; the CI gate passes it so the fixture is inside collection hours at any hour. `CODESPAR_AGENT_NOW` in the environment is the same pin and reaches every command (`approve`, `resume`, `poll`, `rerun`, `reconcile`); the flag wins when both are set. |
| `npm start -- --scenario <name> [--mode human\|mandate] [--rail stub\|api]` | A scenario pack from `scenarios/`. With `--rail api` and a test key the charge, the poll and the sandbox payer are real, and `cycle_seconds` is measured. |
| `npm run check` | The manifest gate: fails if the prompt, tools or guardrails contradict `agent.yaml`, if `AGENTS.md` and `CLAUDE.md` differ, or if `mcp`, `cli` or `schema` are missing. |
| `npm run eval` | The adversarial suite (`evals/adversarial/`) and every scenario in every mode, on the replay provider and the stub rail. |
| `npm run approve <execution-id>` / `npm run deny <execution-id>` | The operator's decision as its own command: decides an execution left in `awaiting_approval`, writes the section 4.2 artifact, runs it through the same last gate `npm start` uses, and waits for the payer (`--wait`, `--simulate-payer`). |
| `npm run poll [--wait <s>] [--simulate-payer]` | Keeps looking at every receivable still waiting for its payer. Shows an instrument not shown yet, tells the payer the outcome once, fetches the paid record. |
| `npm run webhook [--port 8787] [--secret <trigger secret>]` | The receiving end of `channels/webhook` on localhost. A stub: you register the trigger and expose the URL. |
| `npm run resume` | After a crash: dispatches only what the outbox proves was never sent, reconciles the rest from the rail. Never issues twice. |
| `npm run rerun <run-id>` | Replays a recorded run with no network and checks the state sequence matches; the payer's behaviour (paid, expired) is read from the recording. |
| `npm run reconcile` | Compares local state with the rail. One look, read-only; names what is waiting for a payer, what is uncertain, what record is missing locally. |
| `npm run inspect <run-id> [--json] [--html <file>]` | The proof bundle of that run read back as a timeline: who proposed what, who approved it and when (with the `items_hash` and the escalation trigger when one fired), under which version of the mandate, every state transition with its actor, which call went out under which idempotency key, what the rail answered, and which receipts came back. `--json` puts the whole report on stdout and nothing else; `--html` writes one self-contained page that opens from disk with nothing fetched. Payees are masked the way the bundle masks them, and the conversation is reported as counts, not text. |

## The proof bundle

Every run writes `runs/<run-id>/`:

```
transcript.jsonl        the conversation and the tool calls
approval.json           the approval artifacts of the run (section 4.2 of the spec)
mandate.snapshot.json   the collection policy as it was, debtors' documents masked
events.jsonl            every transition, every look, every charge event, every message to the payer, each with its actor
receipts/               the paid charges as the API reports them, each stamped with the actor (kind: charge, unsealed)
run.json                mode, rail, policy id and the version it ran under
```

No key and no secret is written there. Documents are masked; the payer's document is never in a message.

`verify.json` is the one file section 11 names and this repository does not
write: it is the output of `codespar audit replay`, which is not a registered
command of `@codespar/cli`, and the spec forbids a second implementation of
the hash-chain check. `npm run inspect` says so in as many words instead of
leaving the absence to be guessed at.

Read the bundle back with `npm run inspect <run-id>`: the negotiated terms,
who approved them, each receivable the rail accepted, the instrument the payer
was shown as it became payable, and what closed the cycle.

## Limits and stubs

- A policy for the receiving side, signed by the organization, does not exist in the API; the collection policy is the merchant's own file (`mandate.example.json`, in the shape of the consumer mandate, where the named entries are the debtors with an open agreement) and the envelope is the kit's code. Candidate to product (section 16 of the spec).
- The approval artifact is signed by HMAC with a **local development key** (`.codespar/approval.key`). This is a stub: the CodeSpar API does not sign approval lists today. It proves what was approved to whoever runs the agent.
- The API seals no record for a paid charge. The bundle keeps the paid charge as the API reports it, with `simulated: true` when the sandbox payer paid it. Nothing here is proof to anyone outside the merchant.
- Revocation and the kill switch run against a **local stub** (`LocalMandateStatusStub` in `packages/agent-core/src/stubs/mandate-status.ts`); the collection policy has no API-side status to read.
- The `actor` of every call is carried locally on every event, approval and record copy. The API has no `actor` field on the wire today.
- Collection over WhatsApp has rules: hours, secrecy of the debt, no embarrassment, LGPD. The prompt codifies them; the envelope enforces the hours; the code never sends a document.
- CodeSpar does not host or run this agent. The repository delivers it; whoever runs it, runs it.
- What the agent issues inside the policy was authorized by the merchant, and the approval artifact proves what. The split of loss between partner, institution and CodeSpar on an authorized but wrong receivable is contractual and not yet written.

## Going to production

Swap the `csk_test_` key for the production onboarding at https://dashboard.codespar.dev. What changes: the key, the debtors' book (your ERP instead of `src/agreements.ts`), the webhook endpoint for `commerce.charge.*` (or keep the poll), the payer (a real person, not the sandbox route). What does not: the code, `agent.yaml`, the `approval` key, the envelope.
