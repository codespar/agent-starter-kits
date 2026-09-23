---
name: codespar-agent-builder
description: Create a new CodeSpar starter-kit agent under agents/<name> (a payer, a collector or a read-only agent) that passes `npm run check` and the adversarial suite. Use when asked to add, scaffold, build or clone an agent in the agent-starter-kits repository, or to turn a use case into an agent.yaml with prompt, tools, guardrails, scenarios and adversarial cases.
---

# codespar-agent-builder

You are adding `agents/<name>` to `codespar/agent-starter-kits`. The three
agents in the tree are references; yours is the fourth. The manifest
`agent.yaml` is the index, `@codespar/agent-core` is the only thing that
moves an execution past `drafted`, and the task is done when `npm run check`,
`npm run eval --workspace=agents/<name>`, `npm run typecheck` and `npm test`
are green with no model and no CodeSpar key.

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
8. **No overclaims, no telemetry.** Never write "verifiable by a third party"
   (the seals are HMAC today; `check` greps for it). Nothing phones home.

## Procedure

### 0. Decide what kind of agent it is

Pick one, because the tools, the maturity keys and the adversarial expectations
follow from it:

| Kind | It calls | `tools.json` meta-tool `effect` | `agent.yaml` `maturity` key | Reference |
|---|---|---|---|---|
| Payer (money goes OUT under a consumer mandate) | `codespar_pay` | `payment` | `pix-out` | `agents/bills-agent` |
| Collector (money comes IN, a receivable per instalment) | `codespar_charge` | `charge` | `bolepix-receivables` | `agents/collections-agent` |
| Read-only (proposes nothing, pays nothing) | local read tools only | none | none of the two above | this skill's worked example (`docs/OPEN_QUESTIONS.md`, "hello-agent") |

`npm run check` ties the two together: a `payment` tool without `pix-out`
maturity fails, and so does the reverse; same for `charge` and
`bolepix-receivables`.

### 1. Scaffold from the anchor

Copy `agents/bills-agent` to `agents/<name>` and delete what the kind does not
need, following the table in [reference/anatomy.md](reference/anatomy.md). Do
not edit `agents/bills-agent` or `agents/collections-agent`.

Then:

- `package.json`: `"name": "@codespar/<name>"`, keep `"private": true`,
  `"type": "module"`, the `scripts` block and the dependency
  `"@codespar/agent-core": "0.1.0"`. Drop the `consent` script for a
  non-payer.
- Run `npm install` at the repository ROOT so the workspace links the new
  package (installing inside `agents/<name>` does not bring the root
  toolchain).
- Rename the test-only env prefix `BILLS_` (`BILLS_STATE_DIR`,
  `BILLS_RUNS_DIR`, `BILLS_KILL_AFTER_DISPATCH`, `BILLS_STUB_REFUSE`) in
  `src/setup.ts` to your own prefix, and use the new names in `test/`.

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
`read`; `local_tools` are the agent's own read-only helpers. Each entry has
`name`, `effect`, `description`, `input_schema` (JSON Schema). Names are
unique. The shapes are a snapshot written against the `mcp` pin, not fetched
at runtime (the CI has no key and no network). Implement one handler per tool
in `src/modules/<module>.ts` and register them in `setup.ts` `handlers`; a
payment/charge handler calls `ctx.engine.draft(...)` and hands the result to
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
`exfiltration`, `model-total`, `webhook-replay`. Every case except
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

### 9. Wire the root and run the gates

- Root `package.json` `typecheck`: append `&& tsc --noEmit -p agents/<name>/tsconfig.json`.
- `.github/workflows/ci.yml`, step "adversarial suite + scenarios": add
  `npm run eval --workspace=agents/<name>`.
- Root `README.md`, table "What is here": one row.

Then, at the repository root, all four must pass:

```
npm run check                                   # every workspace + the plugin manifests
npm run eval --workspace=agents/<name>          # section 9 suite + every scenario in every mode
npm run typecheck
npm test
node scripts/secret-scan.mjs all
```

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
| `doc_overclaims` | "verifiable by a third party" in a doc |

| `eval` failure | Meaning |
|---|---|
| `must_refuse: something reached executing` | the core let the attack through; check the mandate allowlist and caps, not the prompt |
| `must_escalate: nothing reached awaiting_approval` | in `mandate` mode the trigger did not fire; check `escalate_above` and `warm_payees` |
| `replay transcript exhausted` | the run asked the model for more steps than the transcript holds; add the missing `assistant_step` line |
| `states [...] != [...]` | the scenario's `expect` does not match the trail; fix the expectation only if the trail is the right one |
