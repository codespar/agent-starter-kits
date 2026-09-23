# Anatomy of an agent

Spec section 5, as `agents/bills-agent` ships it. The third column says what
to do with each file when you scaffold `agents/<name>` from that directory.

| Path | What | For the new agent |
|---|---|---|
| `agent.yaml` | The manifest (schema 1). `npm run check` reads it first. | WRITE. See `manifest.md`. |
| `SYSTEM_PROMPT.md` | Persona, rules, limits. | WRITE. Must name the agent; may name only tools of `tools.json`. |
| `tools.json` | Closed list of tools: `meta_tools` (`codespar_*`) and `local_tools`. | WRITE. Minimal. |
| `guardrails.json` | What the agent applies alone, before the mandate. | WRITE. `approval` and `escalate_above` mirror the manifest. |
| `mandate.example.json` | Caps, allowlist, named payees, expiry. | WRITE. `agent_id` is the agent's name. |
| `AGENTS.md`, `CLAUDE.md` | Rules for the coding agent. Identical. | WRITE one, copy the other. |
| `README.md` | What it proves, what is sandbox, what it applies alone, commands. | WRITE. Never "verifiable by a third party". |
| `runbook.md` | The forty-second script. | WRITE. |
| `.env.example` | `CODESPAR_API_KEY` and `ANTHROPIC_API_KEY`. Only. | COPY verbatim; only the comment lines may change. |
| `package.json` | Workspace package, scripts, `@codespar/agent-core` dependency. | ADAPT: `name`, `description`; drop `consent` for a non-payer. |
| `tsconfig.json` | Extends `../../tsconfig.base.json`. | COPY verbatim. |
| `evals/eval.yaml` | `extends: ../agent.yaml` plus metrics. | COPY verbatim. |
| `evals/adversarial/*.json` + `*.transcript.jsonl` | Section 9 cases. | WRITE seven cases. See `evals.md`. |
| `scenarios/*.json` + `*.transcript.jsonl` | Section 12 packs. | WRITE at least `happy-path`. See `evals.md`. |
| `channels/terminal/index.ts` | The terminal channel of `npm start`: describes what the core decided, asks on `awaiting_approval`, runs `approved`. | ADAPT: the `formatBRL` import (from your fixture file) and the two banner strings. The logic stays. |
| `src/main.ts` | `npm start`, `--input`, `--scenario`, `--json`. | ADAPT: the usage text; a non-payer removes the embedded-consent block (lines that import `./modules/embedded-consent.js` and the `if (railKind === "api" && !loadLocalMandate(...))` branch) and its `createCodeSparClient`/`loadMandate` imports. |
| `src/setup.ts` | Wires manifest, guardrails, tools, state, rail, status source, signer, bundle, provider. | ADAPT: the `handlers` map (your tool handlers), the module imports, the `BILLS_` env prefix, and for a non-payer the `railKind === "api"` branch (a read-only agent has no rail: force `stub` and load `mandate.example.json`). |
| `src/bills.ts` | The deterministic fixture the demo reads (`BILLS`, `MONTH`, `formatBRL`). | REPLACE with your own fixture file (keep a `formatBRL` for the channel). |
| `src/modules/pix-out.ts` | The tool handlers: `codespar_pay` drafts through the engine, `codespar_ledger` and `list_bills` read. | REPLACE with `src/modules/<your-module>.ts`: one handler per tool of `tools.json`. |
| `src/modules/embedded-consent.ts` | The partner-surface consent that mints the mandate with a test key. | KEEP for a payer (the mandate is born here); DELETE for a collector or a read-only agent. |
| `src/adversarial.ts` | Section 9 runner: loads cases, replays the worst model, checks transitions. | COPY; ADAPT only `runEventsCase` (it drafts `{ payee: "escola", amount: 1000 }`: use an alias of YOUR mandate) and the `bills-adv-` temp-dir prefix. |
| `src/scenarios.ts` | Section 12 runner. | COPY; ADAPT only the `bills-` temp-dir prefix. |
| `src/commands/check.ts` | `npm run check`. | COPY verbatim. |
| `src/commands/eval.ts` | `npm run eval`. | COPY verbatim. |
| `src/commands/approve.ts`, `deny.ts`, `decide.ts` | The human decision as its own command. | COPY verbatim. |
| `src/commands/resume.ts`, `reconcile.ts`, `rerun.ts` | Restart, reconciliation, replay. | COPY verbatim (`rerun.ts`: adapt the `bills-rerun-` prefix). |
| `src/commands/consent.ts` | `npm run consent`. | KEEP for a payer; DELETE otherwise. |
| `test/check.test.ts` | `check` passes on the shipped agent and fails on each contradiction. | COPY; the copy list inside `copyAgent()` is generic. |
| `test/adversarial.test.ts` | Every case passes; the `required` list is the seven names. | COPY; ADAPT the assertions that name bills-agent states (`tools_refused`, `fractioning` states). |
| `test/scenarios.test.ts` | Every scenario in every mode; every event and receipt carries an actor. | COPY; ADAPT the `required` list to your scenarios and drop the `happy-path` two-mode assertion if your agent has one mode. |
| `test/cli.test.ts` | `--json` on stdout only, restart-then-resume, rerun, approve/deny. | COPY for a payer (rename the `BILLS_` env vars); a read-only agent keeps the `--json` and `check` blocks only. |
| `test/provider.test.ts` | `resolveProvider` treats the placeholder key as no key. | COPY verbatim. |
| `.codespar/`, `runs/` | Local state, the signed mandate, proof bundles. Gitignored. | Never commit. |

## What the copied runner gives you for free

- `npm run check` (the manifest gate, `checkAgent` in the core).
- `npm run eval` (the section 9 suite plus every scenario in every mode, replay provider, no network).
- `npm start -- --input "..." [--approve|--deny] [--json]`, `--scenario <name>`, interactive `npm start`.
- `npm run approve|deny <execution-id>`, `npm run resume`, `npm run reconcile`, `npm run rerun <run-id>`.
- The proof bundle under `runs/<run-id>/` (transcript, approvals, mandate snapshot, events, receipts), every line stamped with `actor`.
- The `csk_test_` guard, the replay provider when `ANTHROPIC_API_KEY` is empty, and `--json` on stdout with people on stderr.

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
