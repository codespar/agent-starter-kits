# `agent.yaml`, schema 1

Source of truth: `packages/agent-core/src/manifest.ts` (the Zod schema) and
`packages/agent-core/src/check.ts` (what `npm run check` refuses). The schema
promises stability: a field is removed or changes meaning only under a new
`schema` number.

## Fields

| Field | Type | Rule |
|---|---|---|
| `schema` | `1` | Literal. Missing: `manifest_field_missing`. |
| `name` | string | `^[a-z0-9-]+$`. The directory name. Must appear in `SYSTEM_PROMPT.md` and as `agent_id` of `mandate.example.json`. |
| `version` | string | `X.Y.Z`. |
| `approval` | `[human \| mandate]` | Non-empty. The modes the agent supports. |
| `default_approval` | `human \| mandate` | Must be one of `approval`. Equals `guardrails.approval`. |
| `escalate_above` | object, optional | `amount` (positive int, minor units), `new_beneficiary` (bool), `outside_hours` (`"HH:MM-HH:MM"`, may cross midnight; it is the CLOSED window in which execution asks a human). Strict: no other keys. Byte-for-byte equal to `guardrails.escalate_above`, or absent in both. |
| `mcp` | string | `@codespar/mcp@X.Y.Z`, exact. Copy from `agents/bills-agent/agent.yaml`. |
| `cli` | string | `@codespar/cli@X.Y.Z`, exact. Copy from `agents/bills-agent/agent.yaml`. |
| `tools` | path | `./tools.json`. |
| `guardrails` | path | `./guardrails.json`. |
| `mandate_schema` | path | `./mandate.example.json`. |
| `events` | string[] | Each `^commerce\.[a-z_.]+$` AND a member of `PUBLISHED_EVENTS` (`packages/agent-core/src/events.ts`); otherwise `events_unknown`. `[]` is valid. |
| `channels` | `[terminal \| whatsapp]` | Non-empty, and `terminal` is required: `npm start` opens it and it needs no account. Checked against what the agent SHIPS, both ways — declare `whatsapp` and you must ship at least one conversation under `channels/whatsapp/` (`channels_not_shipped`), and shipping one without declaring it fails too (`channels_undeclared`). A conversation names the contact it is bound to, the subject it may be about and the person's turns; the schema is `ConversationScriptSchema` in `packages/agent-core/src/channels.ts`. A new agent declares `[terminal]` unless it has a conversation to ship. |
| `maturity` | map string → `live \| sandbox \| blocked` | Any capability names. `pix-out` present ⇔ `tools.json` has a `payment` meta-tool; `bolepix-receivables` present ⇔ a `charge` meta-tool. `receipt-verification: live` is a warning (Ed25519 is not there yet). `{}` is valid. |
| `scenarios` | path | `./scenarios/`. Must exist. |
| `evals` | path | `./evals/`. Must exist and hold `eval.yaml`. |
| `agents_md` | path | Must resolve to `./AGENTS.md`. |

Unknown keys fail (`strict`).

## The pins

The pinned versions live in one place per agent and are copied, never typed
from memory. As of the anchor agent's manifest:

```yaml
mcp: "@codespar/mcp@0.5.8"
cli: "@codespar/cli@0.14.0"
```

**Read the current values from `agents/bills-agent/agent.yaml` at the moment
you scaffold, not from this block.** The example above goes stale by design:
it was `0.13.0` here while the anchor already carried `0.14.0`, which is a
trap for anyone who copies the reference instead of the anchor.
`docs/OPEN_QUESTIONS.md` section 1 says why the pins are what they are.
Updating a pin is its own PR with the suite green, not a side effect of your
agent.

## Published events

`PUBLISHED_EVENTS` in `packages/agent-core/src/events.ts`, measured against
the API on 2026-09-23:

```
commerce.payment.succeeded | failed | pending | refunded | updated
commerce.pix_out.succeeded | failed
commerce.charge.created | paid | expired | cancelled
commerce.mandate.granted | paused | resumed | revoked
```

There is no `commerce.payment.settled`; the execution STATE is `settled`, the
event is `succeeded`. A payer declares `[commerce.payment.succeeded,
commerce.payment.failed]`; a collector the four `commerce.charge.*`; a
read-only agent `[]`.

## `guardrails.json` (`packages/agent-core/src/guardrails.ts`)

```json
{
  "approval": "human",
  "escalate_above": { "amount": 150000, "new_beneficiary": true, "outside_hours": "22:00-07:00" },
  "velocity": { "window_hours": 24 },
  "outside_hours_action": "escalate",
  "model_total_mismatch": "use_core",
  "approval_ttl_minutes": 15,
  "timezone": "America/Sao_Paulo"
}
```

Optional: `velocity.max_per_payee`, `envelope` (free map the core carries to
your `policyExtension`; it does not interpret the keys). Strict.

## `tools.json` (`packages/agent-core/src/tools.ts`)

```json
{
  "meta_tools": [ { "name": "codespar_pay", "effect": "payment", "description": "...", "input_schema": { "type": "object", "properties": {}, "required": [] } } ],
  "local_tools": [ { "name": "list_bills", "effect": "read", "description": "...", "input_schema": { "type": "object", "properties": {} } } ]
}
```

Names `^[a-z][a-z0-9_]*$`, unique across both lists; meta-tools start with
`codespar_`; `effect` is `payment`, `charge` or `read`. Both lists may be
empty. Strict.

## `mandate.example.json` (`packages/agent-core/src/mandate.ts`)

```json
{
  "id": "mdt_example_<name>_0001",
  "version": 1,
  "consumer_id": "usr_demo_titular",
  "agent_id": "<name>",
  "purpose": "...",
  "currency": "BRL",
  "cap_minor": 7200000,
  "per_tx_cap_minor": 250000,
  "periodic_cap": { "window": "month", "cap_minor": 600000 },
  "merchant_pin_kind": "pix-key",
  "merchant_allowlist": ["financeiro@escola-aurora.example.com.br"],
  "beneficiaries": [ { "alias": "escola", "name": "Escola Aurora", "payee": "financeiro@escola-aurora.example.com.br" } ],
  "status": "active",
  "expires_at": "2027-09-23T00:00:00.000Z",
  "source": "example"
}
```

Rules: `per_tx_cap_minor <= cap_minor`; `periodic_cap.cap_minor < cap_minor`
(the API's `periodic_cap_never_binds`); every beneficiary `payee` is in
`merchant_allowlist`; aliases `^[a-z0-9_-]+$`; `merchant_pin_kind` is
`pix-key`, `merchant-id`, `mcc` or `document` (a collector lists its DEBTORS
under `document`); `"*"` is never treated as authorizing a payee. Strict.

## Everything `npm run check` refuses

From `packages/agent-core/src/check.ts`, in order:

- `manifest_missing`, `manifest_field_missing` (`schema`, `mcp`, `cli`), `events_unknown`, `manifest_invalid` (any Zod issue).
- `tools_missing`, `tools_invalid`, `tools_contradict_manifest` (payment ⇔ `pix-out`, charge ⇔ `bolepix-receivables`).
- `guardrails_missing`, `guardrails_invalid`, `guardrails_contradict_manifest` (`approval`, `escalate_above`).
- `mandate_missing`, `mandate_invalid`, `mandate_contradicts_manifest` (`agent_id`).
- `prompt_missing`, `prompt_contradicts_manifest` (does not name the agent; mentions an unsupported `approval:` mode), `prompt_contradicts_tools` (names a `codespar_*` outside `tools.json`).
- `agents_md_missing`, `claude_md_missing`, `agents_md_diverges`, `manifest_agents_md`.
- `scenarios_missing`, `evals_missing`, `eval_missing`, `eval_extends`, `eval_redeclares_manifest`.
- `doc_missing` (`README.md`, `runbook.md`), `doc_overclaims` ("verificável por terceiro", "verifiable by a third party", "third-party verifiable" in README, runbook or prompt).
- `env_example_missing`, `env_example_extra`, `env_example_incomplete`.
- Warning only: `maturity_overclaims`.
