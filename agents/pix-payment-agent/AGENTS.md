# Rules for the coding agent working on pix-payment-agent

You are editing a reference agent of the CodeSpar Agent Starter Kits. These rules keep it a reference.

1. **Read `agent.yaml` before editing anything.** It is the index. `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` and `mandate.example.json` must agree with it, and `npm run check` fails when they do not.
2. **Do not widen `tools.json`, the collection policy or the order book without asking.** The tool list is closed on purpose; the customers' book and the caps are the store's, not yours. Adding a tool, a customer or a way to change an order's amount is a product decision, not a refactor.
3. **The model proposes, the code executes.** Nothing you write may let a model output reach `executing` without going through `ExecutionEngine` in `@codespar/agent-core`. The order policy (`src/orders.ts`, one order per charge, exactly its total) is a `policyExtension` the core runs at every gate; a new check goes there or in the core, never in the prompt.
4. **`escalate_above` only tightens.** A trigger may send an execution to the store; it may never raise a cap, add a customer or change an order.
5. **`actor` on everything.** Every event, approval and receipt copy carries who acted. A record without an actor fails the CI.
6. **Sandbox by construction.** Only `csk_test_` keys. Never commit `.env`, `.codespar/` or `runs/`. The pre-commit secret scan and the CI both refuse a key-shaped string. The sandbox payer is test-environment only and the code never calls it with anything else.
7. **One charge per order, one `idempotency_key` per charge.** The key is the attempt id; a retry must return the same charge, never a second one the same customer could pay twice. Do not touch that.
8. **The cycle closes on the state machine, not on prose.** `commerce.charge.paid` settles; `expired` and `cancelled` fail. By poll or by webhook (`npm run poll`, `npm run webhook`), once and only once. A duplicate event never sends the customer a second message.
9. **The rails are shared, not copied.** The stub and API charge rails are `@codespar/agent-core`'s; on the integrated Test the runtime charges through the platform's receive proposals (CONTRATO v1.6), selected by `hosted.platformServes` in `src/kit.ts`. Do not add a rail here.
10. **Before you say a task is done:** `npm run check`, `npm run eval` (adversarial suite plus scenarios, on the replay provider, no model needed) and `npm test` at the repository root. All green, or it is not done.
11. **Use the CodeSpar MCP and skills** (`@codespar/mcp@0.5.8`, pinned in `agent.yaml`) to learn the real API. When the spec in `docs/spec-v5.1.1.md` and the API diverge, follow the API and log it in `docs/OPEN_QUESTIONS.md`.
12. **Do not write "verifiable by a third party"** anywhere in this agent. The Ed25519 seal a third party can check exists on a PAYMENT receipt; this agent issues charges, and the API seals no record for a paid charge. The approval artifact is HMAC with a local key.
13. **No telemetry.** Nothing in this repository phones home.

`AGENTS.md` and `CLAUDE.md` are the same file; the CI fails if they diverge. Edit both or neither.
