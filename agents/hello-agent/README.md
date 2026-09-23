# hello-agent

The template product of the `codespar-agent-builder` skill (`skills/codespar-agent-builder/SKILL.md`), built by a coding agent following only that file. It is the read-only kind: it lists the month's bills for the titular and refuses everything else. It has no payment tool, so nothing the model says can create an execution; every attempt to pay is refused at `tools.json`, before the core.

```
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
npm install                                                   # at the repository root (npm workspace)
npm start --workspace=agents/hello-agent -- --input "quais contas vencem em outubro?"
```

No key is needed: the agent calls no API. `ANTHROPIC_API_KEY` may stay empty; without it the kit replays the recorded happy path. A `CODESPAR_API_KEY` that is present and not a `csk_test_` key is still refused before anything runs.

## What it proves

| Contract | How |
|---|---|
| The tool list is closed | `tools.json` lists `list_bills` and nothing else. A model that calls `codespar_pay` (every adversarial transcript does) is refused with `tool_not_allowed` before any handler, and the refusal is in the trail. |
| Nothing reaches `executing` | There is no path from the model to `ExecutionEngine.draft`. The suite checks the state machine: `states: []` in every conversation case. |
| Readable refusal | The tool result says `codespar_pay is not in this agent's tools.json`; the agent says nothing was sent. |
| Sandbox by construction | No API call at all; a key outside `csk_test_` is refused anyway. |

## What is sandbox, what the agent applies alone, what is out

`agent.yaml` `maturity` is empty: no capability touches the API. `guardrails.json` carries the defaults (24-hour velocity window, `use_core` for totals) that the core would apply if an execution ever existed; the model can create none. The `webhook-replay` case of the suite drives the core directly, as it does in every agent, and holds here too.

Out: paying (that is `agents/bills-agent`), collecting (`agents/collections-agent`), WhatsApp.

## Commands

| Command | Does |
|---|---|
| `npm start` | Interactive terminal. |
| `npm start -- --input "quais contas vencem em outubro?" [--json]` | One turn. `--json`: machine data on stdout, people on stderr. Add npm's `-s` to pipe it. |
| `npm start -- --scenario <name>` | A scenario pack from `scenarios/`. |
| `npm run check` | The manifest gate. |
| `npm run eval` | The section 9 suite (`evals/adversarial/`) and every scenario, on the replay provider. |
| `npm run approve` / `deny` / `resume` / `reconcile` / `rerun` | Inherited from the runner; with no executions they have nothing to do and say so. |

## What this README declares

- This agent moves no money and issues no charge. The only thing it reads from the mandate is the list of named payees, locally.
- The proof bundle under `runs/<run-id>/` carries the transcript and every tool refusal, each with its `actor`.
- CodeSpar does not host or run this agent. The repository delivers it; whoever runs it, runs it.

## Going to production

There is nothing to switch: this agent never calls the API. To pay, start from `agents/bills-agent` and swap its `csk_test_` key for the production onboarding at https://dashboard.codespar.dev.
