# Rules for the coding agent working on topup-agent

You are editing a reference agent of the CodeSpar Agent Starter Kits. These rules keep it a reference.

1. **Read `agent.yaml` before editing anything.** It is the index. `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` and `mandate.example.json` must agree with it, and `npm run check` fails when they do not.
2. **Do not widen `tools.json`, the mandate or the limits without asking.** The tool list is closed on purpose. The one account (`minha-conta`) and the two limits are the person's; adding an account or raising a limit is a product decision, not a refactor.
3. **The model proposes, the code executes.** Nothing you write may let a model output reach `executing` without going through `ExecutionEngine` in `@codespar/agent-core`. A new check goes in the core or in a `policyExtension`, never in the prompt.
4. **`escalate_above` only tightens.** A trigger may send a pull to a human; it may never raise a cap or add an account.
5. **`actor` on everything.** Every event, approval and record copy carries who acted.
6. **One limit, two readers.** `sweepingLimits` reads `INICIADOR_TOTAL_CENTS` and `INICIADOR_TX_LIMIT_CENTS` once, and BOTH the bank authorization and the mandate take them from there. Never set one of them anywhere else.
7. **One pull per approved execution.** The rail writes its marker to state.db before the payment request goes out; a lost answer is reported as uncertain and never sent again. Do not add a retry around `createPayment`.
8. **No credential in a tracked file, no credential in an output.** `INICIADOR_CLIENT_ID`, `INICIADOR_CLIENT_SECRET` and the access token live in the environment and in memory. Every error from `src/iniciador.ts` goes through `scrub`. The CPF (`INICIADOR_TEST_TAX_ID`) is never printed and never put in a message. Never commit `.env`, `.codespar/` or `runs/`.
9. **Sandbox by construction.** `HttpSweepingApi` refuses a base URL that is not the Iniciador sandbox or a local mock. No test and no CI job reaches Iniciador: the tests drive a fake `fetch` and the stub rail drives `FixtureSweepingApi`.
10. **Do not write "verifiable by a third party"** anywhere in this agent. A pull is not a CodeSpar payment: no chain, no HMAC seal, no Ed25519 signature exists for it. What anyone outside can check is the Pix end-to-end id, at the banks.
11. **Before you say a task is done:** `npm run check`, `npm run eval --workspace=agents/topup-agent`, `npm run typecheck` and `npm test` at the repository root. All green, or it is not done.
12. **No telemetry.** Nothing in this repository phones home.

`AGENTS.md` and `CLAUDE.md` are the same file; the CI fails if they diverge. Edit both or neither.
