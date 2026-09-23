# Open questions and divergences from spec v5.1.1

Kept as the prompt asks: when the spec and the real API diverge, the code follows the API and the divergence is written here. Each entry names what the spec says, what reality showed, what the code does, and who decides. Input for v5.2.

## 1. `cli:` pin — the spec says `@codespar/cli@0.6.0`; npm publishes 0.13.0

`agent.yaml` pins `cli: "@codespar/cli@0.13.0"` (verified on npm on 2026-09-23; 0.6.0 is stale, and 0.12.1, the pin of the first delivery, predates the agent commands). 0.13.0 ships the three commands section 14.5 asks for, with the shapes its `--help` prints: `codespar agent run <dir> [--input <text>] [--approve|--deny]`, `codespar eval <dir>` and `codespar mandate revoke <id> [--reason <text>]`. The READMEs show them with `npx -y @codespar/cli@0.13.0`. The manifest schema accepts any exact version; the check only refuses an unpinned one. The `mcp` pin `@codespar/mcp@0.5.8` matches; `@codespar/sdk` is pinned at 0.16.4 in `packages/agent-core/package.json` (the spec's plan measured 0.16.2). Decision taken 2026-09-23 (#3). **v5.2:** update section 14.4 and the example in 4.3.

## 2. `actor` has no field on the wire

Section 4.5 says every API call carries `actor`. `POST /v1/consumers/mandates/{id}/spend` and `POST /v1/consumer-payments/execute` carry `agent_id` and nothing else about who acts; the receipt (`GET /v1/consumers/receipts/{id}`) carries no actor either. What the code does: the spend sends `agent_id` (which the mandate binds, so attribution is the mandate's, not the caller's); the full `actor` object (`agent` + `on_behalf_of`, or `human` + `channel`) is stamped on every event of `events.jsonl`, on every approval artifact and on the local copy of every receipt. The CI checks the local copies. **Open:** does the API want an `actor` (or `on_behalf_of`) field on spend, and should the receipt carry it? Until then "actor on everything" is true locally and not on the wire.

## 3. Who signs the approval artifact — STUB

The API does not sign approval lists; its HMAC is the mandate proof and the receipt seal. The artifact of section 4.2 is signed with a local development key at `.codespar/approval.key` (generated on first use, mode 0600, gitignored), marked as a stub in `packages/agent-core/src/approval.ts` and in the READMEs. It proves what was approved to whoever runs the agent, and to nobody else. No third env var was added. **Open:** an API-side signature (or Ed25519 with the agent key from KYA) so the artifact means something to a third party.

## 4. Revocation — CLOSED 2026-09-23 (#2); the organization kill switch stays open

Revocation never depended on the AgentGate: the consumer-mandate lifecycle is in the API today. `GET /v1/mandates/{id}` returns the allowance with its `status` (`active | paused | revoked | expired`) and `expires_at` (fourteen fields: `id`, `consumer_id`, `agent_id`, `display_name`, `purpose`, `merchant_allowlist`, `merchant_pin_kind`, `intent_note`, `cap_minor`, `per_tx_cap_minor`, `currency`, `status`, `expires_at`, `created_at`; measured on staging 2026-09-23 for `cm_aYHUpzAX3k39oFTn`), and `POST /v1/mandates/{id}/pause | resume | revoke` move it (`codespar mandate revoke <id>` in CLI 0.13.0). Note the spelling: the point read is registered ONCE, as `/v1/mandates/{id}`; `/v1/consumers/mandates/{id}` (the path issue #2 named) is not an alias and answers 404 — the SDK's OpenAPI says so, and staging confirmed it. What the code does: with a test key `ApiMandateStatusSource` (`packages/agent-core/src/api/mandate-status.ts`) reads that route before every `executing` and the engine executes on `active` only — `paused` → `denied` (`mandate_paused`), `revoked` → `denied` (`mandate_revoked`), `expired` (by status or by `expires_at`) → `expired`, and any read that does not answer (timeout, 5xx, 404, an unreadable body, a status outside the four) → `denied` (`mandate_status_unavailable`). Fail-closed: never "assume active". Without a key the same `MandateStatusSource` interface is answered by `packages/agent-core/src/stubs/mandate-status.ts` over the local state.db, which the `mandate-revoked` scenario drives, and `packages/agent-core/test/mandate-status.test.ts` drives the API source against a mocked HTTP server through the engine (paused, revoked, expired, 500, timeout, 404: `rail.pay` never called). **Still open:** `org pauseAll` has no API surface, so `org_paused` exists only in the stub; and a revocation reaches a running agent by the poll before `executing`, not by `commerce.mandate.revoked` arriving as a trigger.

## 5. Spend by envelope, not by id (revised after the first receipt)

The brief expected `POST /v1/consumer-payments/execute` with `{ mandate, signature }`. The first design spent by id (`POST /v1/consumers/mandates/{id}/spend`) because the hosted consent never hands the envelope to a backend. On staging the by-id route refused the windowed mandate (§14b, ent#1606), so the kit now obtains the envelope through the partner surface (§16) and spends by envelope; by id remains the fallback for a mandate stored without one. **v5.2:** name both routes and when each applies.

## 6. `new_beneficiary: true` makes the first month look like `human` mode

With `escalate_above.new_beneficiary: true` (the example of section 4.3), the first payment to every named payee escalates in `mandate` mode. The happy-path therefore has the same trail in both modes (`awaiting_approval → approved → executing → settled`), which is what the "two modes, one trail" contract asks, and is also why the demo of "the agent runs alone" needs a payee that already has a settled payment (scenario `escalated-above-threshold`, turn 3). Not a bug: it is the ramp of section 4.4. **v5.2:** say so in 4.4.

## 7. Fractioning counts what the agent ran ALONE

Section 9 asks the window to catch five parts below the threshold. The velocity rule (`guardrails.velocity.window_hours`) sums, per payee, the mandate-mode executions the allowance approved without a human inside the window. A payment a human approved is not fractioning, so it does not count; otherwise "the following one, below, runs alone" (4.4) could never happen in the 24 hours after an escalated one. **v5.2:** state the rule in 4.4 or 9.

## 8. Tool definitions are a snapshot, not fetched from the MCP at runtime

Section 5 says the tools come from the MCP. Fetching them live needs a key and network, which the CI does not have, and would make the closed list depend on what a server answers. `tools.json` holds the minimum the bills-agent uses (`codespar_pay` with `action: pix`, `codespar_ledger`, and the local `list_bills`), with the input shape the core accepts; the `mcp` pin in `agent.yaml` names the version those shapes were written against. **Open:** a `npm run tools:sync` that diffs `tools.json` against `@codespar/mcp@<pin>` and fails the check on drift.

## 9. `approval.json` is a list

Section 11 shows one artifact per bundle. A run can hold several executions (the `mandate-revoked` scenario has three), so `approval.json` is an array of artifacts in approval order. Empty runs have no file. **v5.2:** say "one per execution".

## 10. `verify.json` is not written

It is the output of `codespar audit replay` (AgentGate preview). Nothing local should re-implement the hash-chain check, so the bundle has no `verify.json` yet. `npm run inspect` is out of scope.

## 11. `outside_hours` semantics

The spec gives `"22:00-07:00"` as the window in which execution is "outside hours". The code reads it as the CLOSED window (crosses midnight when start > end) in `guardrails.timezone` (default `America/Sao_Paulo`), and `guardrails.outside_hours_action` picks `escalate` (default) or `refuse`. **v5.2:** confirm the reading and the timezone rule.

## 12. First receipt — measured: 375 s from clone to receipt, on STAGING, with two fixes made mid-run

Run on 2026-09-23 with a `csk_test_` key of the staging environment (`https://api.staging.codespar.dev`, org `org_demo`, project `prj_f1622489344f39fe`), no `ANTHROPIC_API_KEY` on the machine (the model was the recorded happy-path transcript through the replay provider; the core, the consent, the spend and the receipt were real). Clock: `git clone` at 04:23:58Z → receipt file at 04:30:13Z = **375 s**, above the five-minute contract. The time includes three things the contract does not: (a) `npm install` inside `agents/bills-agent` did not install the root toolchain (§15), (b) the first consent was refused by `periodic_cap_never_binds` (§14a), (c) the first spend by mandate id answered `bad_signature` (§14b), each fixed, committed and pulled into the timed clone before continuing. The receipt: `rcpt_RgWgZXIcVnokR_1fgwmRi8`, `state: paid`, `sandbox: true`, `money_moved: false`, rail `pix-consent`, mandate `cm_aYHUpzAX3k39oFTn`, in `runs/run_20260923043010_human_cf213e/receipts/` of the bundle (copied out of the deleted clone). One retry was used (the by-id failure was the first attempt). A clean re-run of the fixed path was not made, so no lower number is claimed.

**The contract as written assumes a production test key.** Ours targets staging, which needs `CODESPAR_API_URL` in `.env` — a third variable the spec's `.env.example` forbids. `.env.example` still declares two; the URL is documented as a staging-only extra. **v5.2:** say which environment the five minutes are measured against.

## 14. Two API rules the spec does not state (found on the first consent and the first spend)

a. **`periodic_cap.cap_minor` must be strictly below `cap_minor`** (`400 periodic_cap_never_binds`): the lifetime cap binds first, so a window cap at or above it is "a limit the consumer was shown but never enforced". The spec's "teto mensal que renova sozinho" over "um ano de validade" therefore needs a lifetime cap of at least 12 × monthly. `mandate.example.json` now carries lifetime 7 200 000 / month 600 000, and the local `MandateSchema` mirrors the rule. **v5.2:** state it in 4.3 and in the `mandate.example.json` of section 5.

b. **Spend by id answers `bad_signature` for a mandate that carries `periodic_cap`** (`POST /v1/consumers/mandates/{id}/spend` → `422 mandate_verify` / `bad_signature: consumer mandate verification failed`, staging, 2026-09-23). The signed payload the consent returns includes `periodic_cap`; the stored-row reconstruction the by-id route verifies (`storedMandatePayload` in `consumer-mandate-integrity.ts`) does not name it, so the HMAC never matches. The signed-envelope route (`POST /v1/consumer-payments/execute` with the `{ mandate, signature }` the consent returned) verifies and settles. The kit now spends by envelope when it holds one and falls back to id otherwise. **Enterprise issue: [ent#1606](https://github.com/codespar/codespar-enterprise/issues/1606)** — either the stored-row payload includes `periodic_cap`, or the consent does not sign it.

## 15. `npm install` must run at the repository root

It is an npm workspace; `npm install` inside `agents/bills-agent` installed 13 packages and none of the root devDependencies (`tsx`), so `npm start` died with `ERR_MODULE_NOT_FOUND`. The READMEs and the runbook now say `cd agent-starter-kits && npm install && npm start` (root `npm start` delegates to the agent). **v5.2:** the five-minute script in section 15 should name the directory.

## 16. The hosted consent surface cannot deliver the envelope to a terminal kit

`surface: hosted` (the default) has the consumer sign at `codespar.dev/consent/<token>` and returns `{ mandate, signature }` to the consumer's browser or to a `callback_url`; the partner backend never sees it, and `GET /v1/mandates/{id}` deliberately projects no signed material. With §14b, a kit that only has the id cannot spend a windowed mandate. In the sandbox the kit therefore runs `surface: partner`: it is the partner backend, the titular is at the keyboard, the submit carries `attestation: { method: "in_person" }`, and the envelope is stored in `.codespar/mandate.json` (0600). Sandbox rails accepted a placeholder `provider_token` for `pix-consent`. **Open:** is `in_person` from a terminal an acceptable attestation for a demo, and what should the production kit do (a `callback_url` receiver, or the by-id route once §14b is fixed)?

## 17. `/v1/test/fund` does not credit a `pix-consent` consumer

`POST /v1/test/fund` answered `400 no_provider_account: the consumer has no active pix-celcoin funding source and no account was provided`. The consent created a `pix-consent` funding source, not a `pix-celcoin` account, and the sandbox spend under `pix-consent` settled without any credit (`provider: pix`, `tx_id: mock_psp_…`). The kit treats the credit as best effort and says so. **v5.2:** the "sandbox money" step of section 15 applies to Celcoin-backed consumers only.

## 18. The receipt names no payee unless the spend carries a `quote`

`GET /v1/consumers/receipts/{id}` answered `quote: null`, so the receipt's payee is null; the payee is only on the receipt when the spend presents a `SpendQuote` (`seller`, `resource`, `price_minor`, `payee`). The kit does not send one yet, so the local receipt copy carries the payee from the execution, not from the seal. **Open:** should the kit pass a quote on every spend so the sealed receipt names the payee?

## 19. Things reality showed the spec got wrong (summary for v5.2)

- CLI version (1). `actor` on the wire (2). Who signs the approval list (3). Spend by envelope, because by id fails with `periodic_cap` (5, 14b). `new_beneficiary` and the first month (6). Fractioning counts only autonomous runs (7). `approval.json` is a list (9). `outside_hours` is a closed window in a named timezone (11). Five minutes measured on staging, with a third env var (12). Window cap strictly below lifetime cap (14a). `npm install` at the root (15). Hosted consent cannot hand a terminal kit the envelope; partner surface in the sandbox (16). `/v1/test/fund` is Celcoin-only (17). Receipt payee needs a quote (18). `commerce.payment.settled` is not an API event; `succeeded` is (20). Revocation is in the API, not in the AgentGate; the point read is `/v1/mandates/{id}`, with no `/consumers/` alias (4).

## 20. `commerce.payment.settled` does not exist; the API publishes `commerce.payment.succeeded`

The manifest example of section 4.3 declares `events: [commerce.payment.settled, commerce.payment.failed]`, and the first delivery keyed the core's local settlement event the same way. The API publishes no `settled` event. Its families are `commerce.payment.succeeded | failed | pending | refunded | updated`, `commerce.pix_out.succeeded | failed`, `commerce.charge.created | paid | expired | cancelled` and `commerce.mandate.granted | paused | resumed | revoked` (codespar-enterprise `packages/api/src`, measured 2026-09-23). The manifest and the core now say `commerce.payment.succeeded`; the list lives in one place, `packages/agent-core/src/events.ts`, and `npm run check` refuses an `events:` entry outside it (`events_unknown`). No recorded transcript carried the old name, so `rerun` is unaffected. The execution STATE is still `settled` (section 4.1): the state names what the core concluded, the event names what the rail said. Decision taken 2026-09-23 (#3). **v5.2:** fix the example in 4.3 and name the list.
