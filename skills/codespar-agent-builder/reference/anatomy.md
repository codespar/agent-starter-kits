# Anatomy of an agent

Spec section 5. An agent is a directory of files plus one module; the runner
is `packages/agent-runtime` and is shared. The third column says what to do
with each entry when you build `agents/<name>`.

## Agent-owned

| Path | What | For the new agent |
|---|---|---|
| `agent.yaml` | The manifest (schema 1). `npm run check` reads it first. | WRITE. See `manifest.md`. |
| `SYSTEM_PROMPT.md` | Persona, rules, limits. | WRITE. Must name the agent; may name only tools of `tools.json`. |
| `tools.json` | Closed list of tools: `meta_tools` (`codespar_*`) and `local_tools`. | WRITE. Minimal. |
| `guardrails.json` | What the agent applies alone, before the mandate. | WRITE. `approval` and `escalate_above` mirror the manifest. |
| `mandate.example.json` | Caps, allowlist, named payees, expiry. | WRITE. `agent_id` is the agent's name. |
| `scenarios/*.json` + `*.transcript.jsonl` | Section 12 packs. | WRITE at least `happy-path`. See `evals.md`. |
| `evals/adversarial/*.json` + `*.transcript.jsonl` | Section 9 cases. | WRITE seven cases. See `evals.md`. |
| `evals/eval.yaml` | `extends: ../agent.yaml` plus metrics. | COPY verbatim. |
| `AGENTS.md`, `CLAUDE.md` | Rules for the coding agent. Identical. | WRITE one, copy the other. |
| `README.md` | What it proves, what is sandbox, what it applies alone, commands. | WRITE. "Verifiable by a third party" only where `Ed25519` is written too. |
| `runbook.md` | The forty-second script. | WRITE. |
| `.env.example` | `CODESPAR_API_KEY` and `ANTHROPIC_API_KEY`. Only. | COPY verbatim; only the comment lines may change. |
| `package.json` | Workspace package; every script is `codespar-agent <command>`. | ADAPT: `name`, `description`, the scripts your kind needs. |
| `tsconfig.json` | Extends `../../tsconfig.base.json`. | COPY verbatim. |
| `src/kit.ts` | The one module: the rail, the handlers, the policy extension, the labels. | WRITE. `agents/hello-agent/src/kit.ts` is about thirty lines, most of them one adversarial case. |
| `src/<fixture>.ts`, `src/modules/<module>.ts` | Your deterministic fixture and your tool handlers. | WRITE. A small agent keeps both in one file. |

A **module** is one named capability of the agent, and it is the unit section
2 of the spec means when it says the agents share `pix-out`,
`batch-payout`, `embedded-consent` and `bolepix-receivables`. The name is the
same in three places: the file (`src/modules/pix-out.ts`), the `maturity` key
in `agent.yaml` (`pix-out: sandbox`) and the row in the README's maturity
table. Keeping them aligned is what makes "what is sandbox here" answerable
from the manifest alone. Note that agents do NOT import each other's modules
— there is no shared home for one yet, so an agent that wants another's
capability copies it; see `docs/OPEN_QUESTIONS.md` § 39f.
| `test/*.test.ts` | Your own tests, if you want more than `eval`. | OPTIONAL. Copy from `agents/bills-agent/test`. |
| `.codespar/`, `runs/` | Local state, the signed mandate, proof bundles. Gitignored. | Never commit. |

## Runtime-owned — do not copy any of it into your agent

| Path | What |
|---|---|
| `packages/agent-runtime/bin.mjs` | `codespar-agent`, the one binary your scripts call. |
| `packages/agent-runtime/src/cli.ts` | The command table. |
| `packages/agent-runtime/src/setup.ts` | Manifest, guardrails, tools, prompt, state, signer, bundle, provider, pinned clock. |
| `packages/agent-runtime/src/terminal.ts` | The terminal channel: the banner, the approval question, the transitions, the receipt path. |
| `packages/agent-runtime/src/commands/*.ts` | `start`, `consent`, `approve`, `deny`, `resume`, `rerun`, `reconcile`, `poll`, `webhook`, `check`, `eval`. |
| `packages/agent-runtime/src/scenarios.ts` | The section 12 runner and the pack schema. |
| `packages/agent-runtime/src/adversarial.ts` | The section 9 runner and the case schema. |
| `packages/agent-runtime/src/poll.ts` | Looking at a receivable until the payer acts. |
| `packages/agent-runtime/src/commands/poll-whatsapp.ts` | The same loop, back in a conversation the run that opened it has ended: template outside the 24-hour window, free-form inside it. |
| `packages/agent-runtime/src/webhook.ts` | The trigger receiver: signature, duplicates, out-of-order. |
| `packages/agent-runtime/src/kit.ts` | `AgentKit`: the seam, documented field by field. |

`npm run check` refuses `agents/*/src/main.ts` and `agents/*/src/commands/`:
a runner inside an agent is a fork of the shared one, and every fix would
have to be re-applied to it.

## What the runner gives you for free

- `npm run check` (the manifest gate, `checkAgent` in the core).
- `npm run eval` (the section 9 suite plus every scenario in every mode, replay provider, no network).
- `npm start -- --input "..." [--approve|--deny] [--json] [--now <ISO>]`, `--scenario <name>`, interactive `npm start`. A gate that runs a one-shot passes `--now` so an hours guardrail reads a pinned instant, not the hour the CI happens to run at.
- `npm run approve|deny <execution-id>`, `npm run resume`, `npm run reconcile`, `npm run rerun <run-id>`, and for a collector `npm run poll` (add `--channel whatsapp --conversation <name>` to close the cycle back in the conversation) and `npm run webhook`.
- The proof bundle under `runs/<run-id>/` (transcript, approvals, mandate snapshot, events, receipts), every line stamped with `actor`.
- `npm run inspect <run-id> [--json] [--html <file>]`, which reads that bundle
  back as a timeline. A new agent gets it for nothing: `inspect` reads the
  bundle and nothing else — no kit, no state.db, no network — so it never has
  to learn what your agent pays for. Add the script to `package.json`
  (`"inspect": "codespar-agent inspect"`) and the row to your README's command
  table; there is no code to write.
- The `csk_test_` guard, the replay provider when `ANTHROPIC_API_KEY` is empty or still holds the `.env.example` placeholder, and `--json` on stdout with people on stderr.

## The tool-handler contract

```ts
import type { ToolHandler } from "@codespar/agent-core";

export const myPaymentTool: ToolHandler = async (raw, ctx) => {
  // 1. validate the model's input by hand (throw on a bad shape: the loop records it as tool_failed)
  // 2. hand the proposal to the engine: an execution in `drafted`, then whatever the core decided
  const draft = await ctx.engine.draft({ items: [{ payee: "alias", amount: 12345 }], claimed_total: 12345 });
  if (!draft.ok) return { status: "refused", reason: draft.reason, message: draft.message, paid: false };
  // 3. the channel decides what to do with it (ask, or run); the handler never calls the rail
  const execution = await ctx.onExecution(draft.execution);
  return { status: execution.state, execution_id: execution.id, total_minor: execution.total, paid: execution.state === "settled" };
};
```

A read tool returns data and touches nothing (`ctx.engine.list()`,
`ctx.engine.mandate`, your fixture). No handler may call the rail, the API or
the state store directly.

### One handler, several executions

A handler is not limited to one `draft`. It may loop, and one call becoming N
executions is how `agents/supplier-payments-agent` pays a batch. Reach for the
loop when the lines of the call must succeed or fail **independently**, and
keep them in one execution when they must move together.

The difference is not stylistic, so decide it on the mechanism. A multi-item
execution has ONE `idempotency_key`, ONE approval artifact and ONE terminal
state; N executions have N of each. Both dispatch every attempt and name every
one — the core used to stop at the first refusal, which made the choice look
like a choice between "the list is attested" and "a refusal does not stop the
others"; that was a defect and it is fixed.

So decide on what the LIST is. One execution when the lines are approved as a
unit and a person reads them in one go ("pague as contas de outubro"): what is
attested is the list, as one artifact with one `items_hash` over it. N
executions when each line is independently approvable and the batch can be
large (a payroll, a supplier run): line 57 with a wrong key is fixed and re-run
alone, without sending the other 199 back through approval.

What N executions used to cost: nothing bound the SET, so a bundle where the
agent ran three of four approved lines did not say a fourth existed. Closed by
issue #21, and an agent of that shape now has to do one more thing. Hash the
ordered list ONCE, before any line is drafted, with `batchHash` from
`@codespar/agent-core` — it is `itemsHash` over the whole list, so do not
write a second canonicalisation — and pass `batch: { ref, batch_hash, index,
count }` to every `engine.draft` of that list. The core stamps it on the
execution and every approval artifact carries it, so `inspect` reads the
bundle back as "2 of 4 line(s) attested" instead of two payments. Resolve the
list with `engine.preview`, which does not throw: a line the core would refuse
still occupies its position, or a batch holding a broken line hashes as the
shorter batch without it. See `docs/OPEN_QUESTIONS.md` § 40.

Looping costs you two things you must then handle yourself:

- **Nothing stops the loop.** Every exit from one line — a refusal, a bad
  input — is a `continue`, never a `break` and never a throw past the line it
  is on. A handler that throws on line 2 has silently cancelled lines 3 and 4.
- **A list that changed after it was approved is yours to refuse.** A held
  `batch_hash` that differs from the one in front of you means a person
  decided on a different list, and the surviving lines will each answer
  "already settled" without noticing. Refuse the run before drafting
  anything. Keep that binding under a claim of its own — the claim of a
  DROPPED line is never read again, so it cannot be the thing that remembers
  the set.
- **Re-running is yours to make safe.** Execution ids are random, so a second
  call drafts new executions. A batch line drafted with its `batch` binding
  presents an attempt id derived from the line (`batchAttemptId`), which the
  API recognises across runs and machines (OPEN_QUESTIONS §39c); anything
  else presents an id of its own execution, which it does not. Either way the
  local claim is the first line of defence. `ctx.engine.claim(key, executionId)` and
  `ctx.engine.claimed(key)` record which execution covers a line, durably.
  Take the claim BEFORE `ctx.onExecution`, never after: a crash in between
  then leaves a claim on an OPEN execution, which the next run can refuse to
  duplicate, instead of a settled payout nothing remembers. Read a held claim
  by the state of the execution it names — settled is done, still-open is
  never re-opened, and only `denied`, `expired` or `failed` is retried,
  because only those prove the money did not move.

In `approval: human` the channel asks once per execution, which is what
section 3 of the spec asks for ("o humano aprova cada um") and what lets a
person approve four lines and deny the fifth. The approved list stays
attested either way: `approval.json` holds one artifact per execution, each
with its own `items_hash` bound to the mandate version and, on a batch, the
`batch_hash` of the list it was one of. A denied line is a decision, not a
changed set: it has an execution and no artifact, and the counts still add to
the list that was presented.
