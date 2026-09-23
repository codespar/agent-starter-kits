# bills-agent

The titular delegates the month's bills (school, groceries, the cleaner, utilities) to an agent, under a mandate signed once: a cap per payment, a cap per month, named payees, one year of validity. Every payment returns a receipt. Terminal first; WhatsApp later.

```
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
cp agents/bills-agent/.env.example agents/bills-agent/.env   # CODESPAR_API_KEY (csk_test_...) and ANTHROPIC_API_KEY
npm install && npm start
> pague a escola de outubro
```

`npm install` runs at the repository root (it is an npm workspace; installing inside `agents/bills-agent` does not bring the root toolchain). `npm start` at the root opens this agent; inside `agents/bills-agent`, the same scripts work once the root is installed.

## What it proves

| Contract | How |
|---|---|
| The model proposes, the code executes | `codespar_pay` creates an execution in `drafted`. Only `ExecutionEngine` in `@codespar/agent-core` checks mandate, caps, allowlist, `escalate_above` and `items_hash`, and only it reaches `executing`. |
| Two modes, one trail | `approval: human` (default): the titular approves each payment in the terminal. `approval: mandate`: the agent runs alone inside the signed allowance and asks above `escalate_above`. Same code, same states, same receipts. |
| Approval that matches | Nothing reaches `executing` without an approval artifact whose `items_hash` equals the list about to be executed. Recomputed at execution time. |
| Readable refusal | Cap per payment, cap per month, payee outside the mandate, revoked mandate, outside hours: each names itself in the trail and in the chat. |
| Survives a restart | Kill the process in `executing`, run `npm run resume`: one payment, one receipt. |
| Sandbox by construction | A key that does not start with `csk_test_` fails before any network call. |

## What is sandbox, what the agent applies alone, what is out

Read from `agent.yaml`, field `maturity`:

| Capability | Maturity | Meaning |
|---|---|---|
| `pix-out` | sandbox | Pix payments through the CodeSpar sandbox. No real money. |
| `embedded-consent` | sandbox | The mandate is born at a consent the titular authorizes; in the sandbox the kit runs the partner surface in the terminal. |
| `receipt-verification` | blocked | Waits for Ed25519. The receipt seal is HMAC today. |

What the agent applies on its own, before the mandate (`guardrails.json`): the escalation thresholds (R$ 1.500,00 per payment, first payment to each payee, 22:00–07:00), a 24-hour velocity window per payee against fractioning, and "the core's total wins" when the model states another.

Out of this delivery: WhatsApp, batch payouts, `npm run inspect`, the `codespar init --template` scaffold.

## Commands

| Command | Does |
|---|---|
| `npm start` | Interactive terminal. With a test key and no mandate yet, runs the consent first (partner surface: you are the titular at the keyboard). |
| `npm start -- --input "pague a escola de outubro" [--approve] [--json]` | One turn, no prompt. `--json`: machine data on stdout, people on stderr. Without `ANTHROPIC_API_KEY` it replays the recorded happy-path. To pipe the JSON, add npm's `--silent` (`npm start -s -- --input ... --json \| jq .`): npm itself prints the script banner on stdout. |
| `npm start -- --scenario <name> [--mode human\|mandate]` | A scenario pack from `scenarios/`. |
| `npm run check` | The manifest gate: fails if the prompt, tools or guardrails contradict `agent.yaml`, if `AGENTS.md` and `CLAUDE.md` differ, or if `mcp`, `cli` or `schema` are missing. |
| `npm run eval` | The adversarial suite (`evals/adversarial/`) and every scenario in every mode, on the replay provider. |
| `npm run resume` | After a crash: reconciles what was `executing`, expires what went stale. Never pays twice. |
| `npm run rerun <run-id>` | Replays a recorded run with no network and checks the state sequence matches. |
| `npm run reconcile` | Compares local state with the rail. |
| `npm run consent [--yes]` | Runs a new consent for a mandate (test key, partner surface). The signed envelope is stored in `.codespar/mandate.json`, mode 0600. |

## The proof bundle

Every run writes `runs/<run-id>/`:

```
transcript.jsonl        the conversation and the tool calls
approval.json           the approval artifacts of the run (section 4.2 of the spec)
mandate.snapshot.json   the mandate as it was, keys masked
events.jsonl            every transition and every rail event, each with its actor
receipts/               the receipts the rail returned, each stamped with the actor
run.json                mode, rail, mandate id
```

No key and no secret is written there. Payee keys are masked.

## What this README declares

- The receipt is signed by HMAC with the consumer's secret held by CodeSpar. The chain verifies without network; the signature proves it to whoever runs this agent, and to nobody else until Ed25519.
- The approval artifact is signed by HMAC with a **local development key** (`.codespar/approval.key`). This is a stub: the CodeSpar API does not sign approval lists today. It proves what was approved to whoever runs the agent.
- Revocation and the kill switch (`org pauseAll`) run against a **local stub** of the AgentGate (`packages/agent-core/src/stubs/agentgate.ts`). With a test key, the mandate status is read from the API; the organization pause is not exposed yet.
- The `actor` of every call is carried locally on every event, approval and receipt copy. The API has no `actor` field on the wire today; the spend carries `agent_id`, which the mandate binds.
- A `consumer_id` with an approved account does not leave the registry. Synthetic onboarding stops at document verification, which is the correct behaviour.
- CodeSpar does not host or run this agent. The repository delivers it; whoever runs it, runs it.
- What the agent executes inside the mandate was authorized by the titular, and the approval artifact proves what. The split of loss between partner, institution and CodeSpar on an authorized but wrong payment is contractual and not yet written.

## Going to production

Swap the `csk_test_` key for the production onboarding at https://dashboard.codespar.dev. What changes: the key, the approved `consumer_id`, the webhook endpoint. What does not: the code, `agent.yaml`, the `approval` key.
