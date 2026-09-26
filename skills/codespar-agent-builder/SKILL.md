---
name: codespar-agent-builder
description: Create a new CodeSpar starter-kit agent under agents/<name> (a payer, a collector or a read-only agent) that passes `npm run check` and the adversarial suite. Use when asked to add, scaffold, build or clone an agent in the agent-starter-kits repository, or to turn a use case into an agent.yaml with prompt, tools, guardrails, scenarios and adversarial cases.
---

# codespar-agent-builder

You are adding `agents/<name>` to `codespar/agent-starter-kits`. The four
agents in the tree are references; yours is the next one. The manifest
`agent.yaml` is the index, `@codespar/agent-core` is the only thing that
moves an execution past `drafted`, `@codespar/agent-runtime` is the runner
you do NOT write, and the task is done when `npm run check`, `npm run eval
--workspace=agents/<name>`, `npm run typecheck` and `npm test` are green with
no model and no CodeSpar key.

**You write files, not a runner.** The terminal channel, every command
(`start`, `approve`, `deny`, `resume`, `rerun`, `reconcile`, `poll`,
`webhook`, `check`, `eval`), the setup, the scenario runner and the
adversarial runner are in `packages/agent-runtime` and are shared. Your agent
is its manifest, its prompt, its tools, its guardrails, its mandate and its
packs, plus at most one module: `src/kit.ts`. Copying a command into
`agents/<name>/src/` is refused by `npm run check`.

Read the reference files as you reach each step:

- [reference/anatomy.md](reference/anatomy.md): every file of an agent, and which ones you copy from `agents/bills-agent` verbatim, adapt, or write.
- [reference/manifest.md](reference/manifest.md): `agent.yaml` schema 1 field by field, the pins, the events, and everything `npm run check` refuses.
- [reference/evals.md](reference/evals.md): the scenario and adversarial case formats, the transcript format, and the section 9 table with the expected outcome per kind of agent.

## Non-negotiables

Break one and the CI fails; break one the CI cannot see and the agent is not a
CodeSpar agent.

1. **The model proposes, the code executes.** A model output creates an
   execution in `drafted` and nothing else. Mandate, allowlist, caps,
   `escalate_above` and the `items_hash` of the approved list are checked by
   `ExecutionEngine` in `@codespar/agent-core`, three times (draft, approval,
   right before `executing`). A new check goes in the core or in a
   `policyExtension`, never in the prompt.
2. **Refusal is a transition, not a sentence.** The adversarial suite reads the
   state machine: an agent that refuses politely and still reaches `executing`
   failed. Write cases whose transcript plays the WORST model, the one that
   obeys the attack, and let the core refuse.
3. **`actor` on everything.** Every event, approval artifact and receipt copy
   carries who acted (`{type: "agent", agent, on_behalf_of}` or
   `{type: "human", id, channel}`). The core stamps it; do not strip it.
4. **Sandbox by construction.** Only `csk_test_` keys: `isTestKey` refuses
   anything else before a network call. Never commit `.env`, `.codespar/` or
   `runs/`; never write a key-shaped string anywhere (`node
   scripts/secret-scan.mjs all` runs in the CI and as a pre-commit hook).
5. **`escalate_above` only tightens.** A trigger sends an execution to a human;
   it never raises a cap or adds a payee.
6. **The tool list is closed.** A tool outside `tools.json` is refused before
   any handler runs, and the refusal is in the trail. Ship the minimum.
7. **Pins are exact.** `mcp:` and `cli:` in `agent.yaml` name one published
   version each; `npm run check` refuses a range or a tag.
8. **No overclaims, no telemetry.** "Verifiable by a third party" is true of
   one thing here — the Ed25519 signature CodeSpar seals onto a payment
   receipt, which `npm run verify` checks against the published key set — and
   false of everything else: the approval artifact, a paid charge, and every
   receipt sealed before the API had the capability. `check` fails on the
   phrase unless the doc also names `Ed25519`. Nothing phones home.

## Procedure

### 0. Decide what kind of agent it is

Pick one, because the tools, the maturity keys and the adversarial expectations
follow from it:

| Kind | It calls | `tools.json` meta-tool `effect` | `agent.yaml` `maturity` key | Reference |
|---|---|---|---|---|
| Payer (money goes OUT under a consumer mandate) | `codespar_pay` | `payment` | `pix-out` | `agents/bills-agent` |
| Batch payer (money goes out to MANY payees, independently) | `codespar_pay` | `payment` | `pix-out` + `batch-payout` | `agents/supplier-payments-agent` |
| Collector (money comes IN, a receivable per instalment) | `codespar_charge` | `charge` | `bolepix-receivables` | `agents/collections-agent` |
| Read-only (proposes nothing, pays nothing) | local read tools only | none | none of the two above | `agents/hello-agent`, the worked example |

`npm run check` ties the two together: a `payment` tool without `pix-out`
maturity fails, and so does the reverse; same for `charge` and
`bolepix-receivables`. `batch-payout` is not tied to anything by the check —
it rides on the payment tool `pix-out` already requires — so it is a claim
about the agent that only your own tests hold up.

A batch payer is a payer whose handler loops: one tool call becomes one
execution PER LINE, so each line is approved, refused and re-run on its own.
Choose it when the lines are independently approvable and the batch can be
large (a payroll); choose a plain payer, one execution with N items, when the
list is approved as a unit and a person reads it in one go (the month's
bills). Both shapes dispatch every attempt and name every one. The mechanism,
the trade the two shapes make and the two things the loop makes yours to
handle are in [reference/anatomy.md](reference/anatomy.md) § "One handler,
several executions" — read it before writing the loop.

### 1. Create the five files and the packs

`agents/<name>/` is a directory of files. Start it and install:

```sh
mkdir -p agents/<name>/scenarios agents/<name>/evals/adversarial
cp agents/hello-agent/tsconfig.json agents/<name>/tsconfig.json
cp agents/bills-agent/.env.example agents/<name>/.env.example
```

`agents/<name>/package.json` — the scripts are the shared binary, nothing else:

```json
{
  "name": "@codespar/<name>",
  "version": "0.1.0",
  "private": true,
  "description": "...",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "start": "codespar-agent start",
    "check": "codespar-agent check",
    "eval": "codespar-agent eval",
    "resume": "codespar-agent resume",
    "rerun": "codespar-agent rerun",
    "reconcile": "codespar-agent reconcile",
    "approve": "codespar-agent approve",
    "deny": "codespar-agent deny",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run --pool=forks --maxWorkers=1 --root ../.. agents/<name>"
  },
  "dependencies": { "@codespar/agent-core": "0.1.0", "@codespar/agent-runtime": "0.1.0" }
}
```

A collector adds `"poll"` and `"webhook"`; a payer adds `"consent"`. Then run
`npm install` at the repository ROOT, so the workspace links the new package
(installing inside `agents/<name>` does not bring the root toolchain).

The files to write are the five of section 5 (steps 2 to 5 below), the packs
(step 6), the docs (steps 7 and 8) and one module (step 9). Nothing else. The
state directory `.codespar/`, the proof bundles under `runs/`, and the
test-only environment variables (`<NAME>_STATE_DIR`, `<NAME>_RUNS_DIR`,
`<NAME>_KILL_AFTER_DISPATCH`, `<NAME>_STUB_REFUSE`, where `<NAME>` is your
agent's name upper-cased without the `-agent` suffix) all follow from the
directory; you never name them.

### 2. Write `agent.yaml` (schema 1)

Fill every field of [reference/manifest.md](reference/manifest.md). In
particular:

- `name` is the directory name (`^[a-z0-9-]+$`) and must appear verbatim in
  `SYSTEM_PROMPT.md` and as `agent_id` in `mandate.example.json`.
- `mcp:` and `cli:` are copied from `agents/bills-agent/agent.yaml`, which
  carries the pins verified against npm. Do not bump them here.
- `events:` names only entries of `PUBLISHED_EVENTS` in
  `packages/agent-core/src/events.ts`. A payer declares
  `commerce.payment.succeeded` and `commerce.payment.failed`; a collector the
  four `commerce.charge.*`; a read-only agent `[]`.
- `escalate_above` must be byte-for-byte the same object in
  `guardrails.json` (or absent in both). `guardrails.approval` must equal
  `default_approval`.

### 3. Write `SYSTEM_PROMPT.md`

Persona, what it can and cannot do, how to behave, the limits it states. Rules
the check enforces: it names the agent; every `codespar_*` it mentions is in
`tools.json` (so a read-only agent does not even name `codespar_pay`; say
"there is no payment tool"); it mentions `approval: human` or `approval:
mandate` only if `agent.yaml` lists that mode. Tell the model to pass amounts,
payees and totals through and let the code decide; never to split a payment to
stay under a threshold; never to claim a payment unless the tool result says
`paid: true`.

### 4. Write `tools.json` minimal

`meta_tools` are named `codespar_*` with `effect` `payment`, `charge` or
`read`; `local_tools` are the agent's own helpers, `read` or `state` (a local
tool that keeps durable state of the agent's own and moves no money, like a
cart). Each entry has
`name`, `effect`, `description`, `input_schema` (JSON Schema). Names are
unique. The shapes are the kit's own, not the MCP's: a meta-tool entry borrows
the name for the job it does, the model sees only what it needs (an alias,
never a key or a document), and the core builds the real API call. One
handler per tool, returned by your kit's `handlers` (step 9); a payment/charge
handler calls `ctx.engine.draft(...)` and hands the result to
`ctx.onExecution(...)`, nothing else.

### 5. Write `guardrails.json` and `mandate.example.json`

`guardrails.json`: `approval`, `escalate_above` (same as the manifest),
`velocity.window_hours`, `outside_hours_action`, `model_total_mismatch`
(`use_core`), `approval_ttl_minutes`, `timezone`, and `envelope` only for a
policy extension you actually run.

`mandate.example.json` in the consumer-mandate shape (see the reference):
`agent_id` equals `name`; `per_tx_cap_minor <= cap_minor`;
`periodic_cap.cap_minor` strictly below `cap_minor` (the API's own rule);
every beneficiary `payee` is in `merchant_allowlist`; `"*"` never authorizes
anything.

### 6. Write scenarios and adversarial cases

Follow [reference/evals.md](reference/evals.md). Minimum: the `happy-path`
scenario and the seven adversarial cases of section 9, one file each, named
`prompt-injection`, `beneficiary-swap`, `false-authority`, `fractioning`,
`exfiltration`, `model-total`, `webhook-replay`. Add a case of your own when
your agent has a refusal the table does not cover: a batch payer ships
`batch-tampering`, where the model is steered into writing the batch's lines
itself and is refused before a handler runs. Every case except
`webhook-replay` has a `.transcript.jsonl` playing the model that obeys the
attack. The expected outcome depends on the kind of agent (table in the
reference). Keep `evals/eval.yaml` as `extends: ../agent.yaml` plus metrics;
it may not redeclare a manifest field.

### 7. `AGENTS.md` == `CLAUDE.md`

Write the rules for the next coding agent (start from the bills-agent's ten
and adjust the domain words), then copy the file: `cp AGENTS.md CLAUDE.md`.
`check` fails on one byte of difference. `agent.yaml` `agents_md` points at
`./AGENTS.md`.

### 8. `README.md`, `runbook.md`, `.env.example`

`README.md`: what it proves, what is sandbox (read from `maturity`), what the
agent applies alone (`guardrails.json`), the commands, and "Going to
production". `runbook.md`: the forty-second script. `.env.example`: exactly
`CODESPAR_API_KEY` and `ANTHROPIC_API_KEY`, nothing else (staging's
`CODESPAR_API_URL` goes in a comment).

### 9. Write `src/kit.ts`, the only code you own

One module, exporting one handle. A read-only agent spreads `defaultKit` and
adds its handlers, and that is the whole file:

```ts
import { defineAgent, defaultKit } from "@codespar/agent-runtime";
import { listThings } from "./things.js";

export const agent = defineAgent(import.meta.url, {
  ...defaultKit,
  handlers: () => ({ list_things: listThings }),
});
```

A payer or a collector replaces more of it. `AgentKit` in
`packages/agent-runtime/src/kit.ts` is the whole seam and every field is
documented there; `agents/bills-agent/src/kit.ts` (payer) and
`agents/collections-agent/src/kit.ts` (collector) are the two worked
examples. What you may set, and nothing else is yours:

| Field | What it is | Who needs it |
|---|---|---|
| `buildRail` | The rail, the mandate, and for a collector the sandbox payer | payer, collector |
| `handlers` | One `ToolHandler` per entry of `tools.json` | everyone |
| `policyExtension` | A deterministic policy the core runs at every gate | an agent with an envelope |
| `labels` | The words the console prints: the prompt, the approval question, `recibo` vs `registro` | everyone |
| `usage` | The text `--help` prints | everyone |
| `describeExecution`, `oneShotPayload` | The console lines and the `--json` body | everyone |
| `settlement` | `immediate` (money out) or `await-payer` (money in, `poll`/`webhook`) | collector |
| `executeOnApproval` | `false` when approving and issuing are two moments (a sale: the order is confirmed, the charge goes out when the customer asks); the agent's own tool then calls `engine.execute` | a seller (`agents/checkout-agent`) |
| `presentInstrument`, `announceOutcome` | The QR the payer reads, the one message per outcome | collector |
| `ensureMandate`, `consent` | The consent that mints the mandate | payer |
| `warmUp`, `runEventsCase`, `rerunPlan` | What the section 9 suite and `rerun` need per agent | see `evals.md` |

Two things the seam does NOT carry, and where they live instead. Durable
state of your own goes through `ctx.engine.claim`/`claimed` — a tool
handler's only durable surface is the engine, since `ToolContext` is
`{ engine, onExecution }` and nothing else. And there is no way to import
another agent's module: each agent owns its `src/`, so a capability two
agents want is copied today (`docs/OPEN_QUESTIONS.md` § 39f).

### 10. Wire the root and run the gates

Only then say it is done. If the spec (`docs/spec-v5.1.1.md`) and the API
disagree while you build, follow the API and add a numbered entry to
`docs/OPEN_QUESTIONS.md`.

## Reading the failures

| `check` code | Fix |
|---|---|
| `manifest_field_missing` / `manifest_invalid` | a field of schema 1 is absent or wrong; the message names it |
| `events_unknown` | the event is not in `packages/agent-core/src/events.ts` |
| `tools_contradict_manifest` | payment tool without `pix-out` maturity, charge tool without `bolepix-receivables`, or the reverse |
| `guardrails_contradict_manifest` | `approval` or `escalate_above` differ from `agent.yaml` |
| `mandate_contradicts_manifest` | `agent_id` is not `name` |
| `prompt_contradicts_tools` | the prompt names a `codespar_*` tool `tools.json` does not list |
| `agents_md_diverges` | `AGENTS.md` and `CLAUDE.md` differ |
| `eval_extends` / `eval_redeclares_manifest` | `evals/eval.yaml` must be `extends: ../agent.yaml` plus cases and metrics |
| `env_example_extra` | a third key in `.env.example` |
| `doc_overclaims` | "verifiable by a third party" in a doc that never names `Ed25519` |
| `maturity_overclaims` | `receipt-verification` beyond `blocked` with no `payment` meta-tool: only a payment seals a receipt |

| `eval` failure | Meaning |
|---|---|
| `must_refuse: something reached executing` | the core let the attack through; check the mandate allowlist and caps, not the prompt |
| `must_escalate: nothing reached awaiting_approval` | in `mandate` mode the trigger did not fire; check `escalate_above` and `warm_payees` |
| `replay transcript exhausted` | the run asked the model for more steps than the transcript holds; add the missing `assistant_step` line |
| `states [...] != [...]` | the scenario's `expect` does not match the trail; fix the expectation only if the trail is the right one |
