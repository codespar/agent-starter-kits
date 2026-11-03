# topup-agent

The person's own agent, on WhatsApp, that puts money in their CodeSpar
account by **pulling** it from their own bank account, through Open Finance
(Pix sweeping, via Iniciador). The agent asks for a yes, the code asks the
bank for an authorization and sends the bank's link, the person approves at
the bank, and the code pulls the amount once and answers with the Pix
end-to-end id.

```
você:  oi, quero colocar R$ 1 na minha conta
agent: Posso pedir ao seu banco (Banco de Testes) para puxar R$ 1,00 para a sua conta? Responda sim ou não.
você:  sim
agent: R$ 1,00
agent: Autorize no seu banco. O link vale por cerca de 1 minuto.
       [Autorizar no banco]                         <- a URL button to the bank's consent page (Mocktora in the sandbox)
       ... the person picks the account and taps Autorizar ...
agent: Pronto, o dinheiro caiu na sua conta. Comprovante do Pix (end-to-end): E4447...
```

The link goes as a WhatsApp URL button (Cloud API `interactive`, `cta_url`).
If the provider refuses the button, the same link goes as text under the line
"Autorize no seu banco por este link", and the console and the conversation
log say so (`fallback` in `channel.jsonl`).

## What it proves

| Claim | How |
|---|---|
| The model proposes, the code pulls | `codespar_charge` creates an execution in `drafted`; only `ExecutionEngine` reaches `executing`, and only then does the rail call the bank. |
| One account, two limits, both sides | The mandate has one account (`minha-conta`). `INICIADOR_TOTAL_CENTS` / `INICIADOR_TX_LIMIT_CENTS` (default R$ 10,00 / R$ 5,00) are read ONCE (`sweepingLimits`) and become both the bank authorization's `configuration` and the mandate's `cap_minor` / `per_tx_cap_minor`. |
| The link is created only after the yes | The prompt asks first; the bank authorization is created by the rail when the approved execution is dispatched. The link expires about a minute after it is created. |
| One pull per approval | The payment request is made by the first look that sees `AUTHORISED`, after a marker is written to state.db. A lost answer is `uncertain` forever after, never re-sent. |
| No credential leaves the process | The client id, the secret and the token live in the environment and in memory; every error is scrubbed (tokens, credentials, any 11-14 digit run). The CPF never reaches a message or the console. |

## What is sandbox (`maturity` in `agent.yaml`)

| Module | Maturity | Meaning |
|---|---|---|
| `sweeping-pull` | sandbox | Iniciador's sweeping sandbox (`consumer.sandbox.inic.dev`), trigger MANUAL, simulated bank (Banco de Testes / Mocktora: any user and password). No real money. The client refuses any other host. |
| `receipt-verification` | blocked | A pull is not a CodeSpar payment. No chain, no HMAC seal, no Ed25519 signature exists for it; the local record (`runs/<run-id>/receipts/`) is just that. What someone outside can check is the Pix end-to-end id, at the banks. |

The default rail is an offline fixture (`FixtureSweepingApi`): same rail, same
state machine, no network. `--rail api` is the Iniciador sandbox.

## What it applies alone (`guardrails.json`)

- `approval: mandate` by default: the person's approval is the one at their bank; the mandate bounds what the agent may ask for.
- `escalate_above.amount: 300`: a pull above R$ 3,00, or pulls adding up above it within 24 h (`velocity`), wait for a human even in `mandate`.
- Above R$ 5,00 per pull or R$ 10,00 in total: denied by the core before the bank is asked.

## What the run leaves (`runs/<run-id>/`)

The run's proof bundle has the same masking as every other agent's ([`docs/OPEN_QUESTIONS.md`](../../docs/OPEN_QUESTIONS.md) §37). No API key and no secret is written there, and no account key appears in the clear except in one place. The account's key (the creditor id the mandate names, behind the alias `minha-conta`) is masked in its `payee` fields, in `mandate.snapshot.json`, in `receipts/`, and in the prose fields that can name it: an escalation detail, a rail's refusal message, a turn of the conversation in `transcript.jsonl` and `channel.jsonl`, a tool's result. The one exception is the tool calls in `transcript.jsonl` (`tool_calls`, `input`). `rerun` replays them byte for byte, and the mandate resolves an account by its key as well as by its alias, so they are written as the model sent them. `codespar_charge` asks for the alias and never a key. A key therefore shows up there only when the model disobeys that and puts one (or a Pix key the person typed) in `account`, and it is written there in the clear. Read `transcript.jsonl` before handing the folder over. The full record stays in `.codespar/state.db`, which never travels.

`receipts/` is a local record, not a sealed receipt: `receipt-verification` is `blocked` in this kit (above), so `npm run verify` has nothing to check here.

## Commands

| Command | What |
|---|---|
| `npm start` | Interactive terminal, offline fixture. |
| `npm start -- --scenario happy-path` | A scenario pack (see `scenarios/`). |
| `npm run eval` | The section 9 suite plus every scenario, replay provider, no network. |
| `npm start -- --channel whatsapp --conversation recarga --scripted --simulate-payer` | The conversation over the local WhatsApp emulator (`npm run whatsapp:emulator` at the repo root), offline fixture. |
| `npm start -- --channel whatsapp --conversation recarga --rail api --wait 300` | The demo against the Iniciador sandbox (below). |
| `npm run poll -- --channel whatsapp --conversation recarga` | Back to a conversation whose pull completed after the run stopped looking. |
| `npm run inspect <run-id>` | The run's bundle as a timeline. |

## The sandbox demo

In the shell that runs it (the values never go in a tracked file, and never in a chat):

```sh
set -a; . ~/.config/codespar/iniciador-sandbox.env; set +a   # INICIADOR_CLIENT_ID, INICIADOR_CLIENT_SECRET, INICIADOR_TEST_TAX_ID
export INICIADOR_CREDITOR_ID=<user-creditor id>       # POST /sweeping/user-creditors, the person's own account
export INICIADOR_TRIGGER_ID=<MANUAL trigger id>       # GET /sweeping/recurring-triggers
export INICIADOR_PARTICIPANT_ID=<Banco de Testes id>  # GET /sweeping/participants
npm run whatsapp:emulator                             # in another terminal, at the repo root
npm start -- --channel whatsapp --conversation recarga --rail api --wait 300
```

Type the person's turns (`oi, quero colocar R$ 1 na minha conta`, then `sim`),
open the link the moment it arrives, log in with any user and password, pick
the account and tap Autorizar. The run looks every 2 seconds; a pull the
`--wait` did not see complete is left to `npm run poll`.

## Going to production

Not in this kit. It needs Iniciador production credentials and an AUTOMATIC
trigger (not provisioned in the sandbox as of 2026-10-27), real `riskSignals`
for a person who is not at a device, a webhook instead of the poll, and a
decision on what record a pull leaves: today nothing is sealed for it.
