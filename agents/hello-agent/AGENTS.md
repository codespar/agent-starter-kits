# Rules for the coding agent working on hello-agent

You are editing the worked example of the `codespar-agent-builder` skill: a read-only agent that lists the month's bills and pays nothing. These rules keep it that.

1. **Read `agent.yaml` before editing anything.** It is the index. `SYSTEM_PROMPT.md`, `tools.json`, `guardrails.json` and `mandate.example.json` must agree with it, and `npm run check` fails when they do not.
2. **Do not widen `tools.json` or the mandate without asking.** This agent has one read tool on purpose. Adding a payment or charge tool turns it into another agent (and `check` will demand the matching `maturity` key); that is a product decision, not a refactor.
3. **The model proposes, the code executes.** Here the model cannot even propose: nothing you write may give it a path to `ExecutionEngine.draft`. If the agent needs to pay one day, start from `agents/bills-agent`, not from a prompt change here.
4. **`escalate_above` only tightens.** Absent here, absent in `guardrails.json`; keep them equal.
5. **`actor` on everything.** Every event of the bundle carries who acted; the tool refusals in the trail carry the agent's actor.
6. **Sandbox by construction.** Only `csk_test_` keys, and this agent makes no API call at all. Never commit `.env`, `.codespar/` or `runs/`.
7. **Before you say a task is done:** `npm run check`, `npm run eval` (adversarial suite plus scenarios, on the replay provider, no model needed) and `npm test` at the repository root. All green, or it is not done.
8. **Use the CodeSpar MCP and skills** (`@codespar/mcp@0.5.8`, pinned in `agent.yaml`) to learn the real API. When the spec in `docs/spec-v5.1.1.md` and the API diverge, follow the API and log it in `docs/OPEN_QUESTIONS.md`.
9. **Do not write "verifiable by a third party"** anywhere.
10. **No telemetry.** Nothing in this repository phones home.

`AGENTS.md` and `CLAUDE.md` are the same file; the CI fails if they diverge. Edit both or neither.
