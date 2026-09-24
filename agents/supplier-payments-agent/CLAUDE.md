# Rules for the coding agent working on supplier-payments-agent

You are editing a reference agent of the CodeSpar Agent Starter Kits. These rules keep it a reference.

1. **Read `agent.yaml` before editing anything.** It is the index. `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` and `mandate.example.json` must agree with it, and `npm run check` fails when they do not.
2. **A batch is a loop of executions, one per line.** Never fold a batch back into one multi-item execution to "save a round trip". Not because the core would strand the siblings — it no longer does — but because a payroll line has to be approvable, refusable and re-runnable ALONE: one execution of 200 items is one all-or-nothing decision, and one wrong key sends the whole list back through approval. `src/modules/batch-payout.ts` and `docs/OPEN_QUESTIONS.md` § 40 say why; read them before changing the loop.
3. **The loop `continue`s, it never breaks.** Every exit from one line — a refusal, a claim already held, a malformed line — is a fact about that line only. A change that lets one line throw past the loop is the bug this agent exists to not have.
4. **The claim is the thing that stops a double payment.** `engine.claim`/`claimed` pairs a batch line with the execution that covers it, and it is taken BEFORE the channel can run the execution. Claiming afterwards would leave a settled payout unclaimed on a crash, which is the double payment. Only a claim whose execution ended without moving money (`denied`, `expired`, `failed`) is retried.
5. **The lines of a batch are the company's, not the model's.** `codespar_pay` refuses `batch_ref` together with `items` or `total_minor`. Do not "helpfully" merge them: that refusal is what makes a batch un-fractionable.
6. **Do not widen `tools.json` or the mandate without asking.** The tool list is closed on purpose; the mandate's caps and payees are the company's. Adding a tool or a payee is a product decision, not a refactor.
7. **The model proposes, the code executes.** Nothing you write may let a model output reach `executing` without going through `ExecutionEngine` in `@codespar/agent-core`. If you need a new check, add it to the core or to a `policyExtension`, never to the prompt.
8. **`escalate_above` only tightens.** A trigger may send an execution to a human; it may never raise a cap or add a payee.
9. **`actor` on everything.** Every event, approval and receipt copy carries who acted. A receipt without an actor fails the CI.
10. **Sandbox by construction.** Only `csk_test_` keys. Never commit `.env`, `.codespar/` or `runs/`. The pre-commit secret scan and the CI both refuse a key-shaped string.
11. **Before you say a task is done:** `npm run check`, `npm run eval` (adversarial suite plus scenarios, on the replay provider, no model needed) and `npm test` at the repository root. All green, or it is not done.
12. **Use the CodeSpar MCP and skills** (`@codespar/mcp@0.5.8`, pinned in `agent.yaml`) to learn the real API. When the spec in `docs/spec-v5.1.1.md` and the API diverge, follow the API and log it in `docs/OPEN_QUESTIONS.md`.
13. **Do not write "verifiable by a third party"** anywhere. The receipt seal and the approval artifact are HMAC today.
14. **No telemetry.** Nothing in this repository phones home.

`AGENTS.md` and `CLAUDE.md` are the same file; the CI fails if they diverge. Edit both or neither.
