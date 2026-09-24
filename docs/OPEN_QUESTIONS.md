# Open questions and divergences from spec v5.1.1

Kept as the prompt asks: when the spec and the real API diverge, the code follows the API and the divergence is written here. Each entry names what the spec says, what reality showed, what the code does, and who decides. Input for v5.2.

## 1. `cli:` pin — the spec says `@codespar/cli@0.6.0`; npm publishes 0.13.0

`agent.yaml` pins `cli: "@codespar/cli@0.13.0"` (verified on npm on 2026-09-23; 0.6.0 is stale, and 0.12.1, the pin of the first delivery, predates the agent commands). 0.13.0 ships the three commands section 14.5 asks for, with the shapes its `--help` prints: `codespar agent run <dir> [--input <text>] [--approve|--deny]`, `codespar eval <dir>` and `codespar mandate revoke <id> [--reason <text>]`. The READMEs show them with `npx -y @codespar/cli@0.13.0`. The manifest schema accepts any exact version; the check only refuses an unpinned one. The `mcp` pin `@codespar/mcp@0.5.8` matches; `@codespar/sdk` is pinned at 0.16.6 in `packages/agent-core/package.json` (the spec's plan measured 0.16.2; 0.16.4 was the first pin, 0.16.5 added the sandbox payer route to the OpenAPI document, section 31c, and 0.16.6 types `consumer_id` on the charge create, section 31a). Decision taken 2026-09-23 (#3). Later the same day both pins moved to `@codespar/cli@0.14.0` and `@codespar/sdk@0.16.5`, the versions npm published that day; 0.14.0 adds `init --template bills-agent|collections-agent`. The sdk pin moved once more, to 0.16.6, with #13. **v5.2:** update section 14.4 and the example in 4.3.

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

Run on 2026-09-23 with a `csk_test_` key of the staging environment (`https://api.staging.codespar.dev`, org `org_demo`, project `prj_f1622489344f39fe`), no `ANTHROPIC_API_KEY` on the machine (the model was the recorded happy-path transcript through the replay provider; the core, the consent, the spend and the receipt were real). Clock: `git clone` at 04:23:58Z → receipt file at 04:30:13Z = **375 s**, above the five-minute contract. The time includes three things the contract does not: (a) `npm install` inside `agents/bills-agent` did not install the root toolchain (§15), (b) the first consent was refused by `periodic_cap_never_binds` (§14a), (c) the first spend by mandate id answered `bad_signature` (§14b), each fixed, committed and pulled into the timed clone before continuing. The receipt: `rcpt_RgWgZXIcVnokR_1fgwmRi8`, `state: paid`, `sandbox: true`, `money_moved: false`, rail `pix-consent`, mandate `cm_aYHUpzAX3k39oFTn`, in `runs/run_20260923043010_human_cf213e/receipts/` of the bundle (copied out of the deleted clone). One retry was used (the by-id failure was the first attempt). A clean re-run of the fixed path was not made, so no lower number is claimed. **Re-measured the same day** by a context-free run following only the README, on the fixed path, no retry: **77 s** from `git clone` to a receipt the API answered with 200 (`rcpt_qJj98xRkdbNREXA9E9fjBx`, mandate `cm_i6XACvqXiwkoe60p`, `sandbox: true`, `money_moved: false`); 27 of those seconds were a first `npm start -- --input` refused for lack of a mandate, which [issue #8](https://github.com/codespar/agent-starter-kits/issues/8) fixed in the quick path.

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

# The collections-agent (plan item 2.2), against spec v5.2

Same rule. Entries 21 to 30 come from building `agents/collections-agent` over `kits/bolepix-receivables` on 2026-09-23, against the API on `main` (ent#1600 merged, `POST /v1/test/charges/{id}/pay` deployed on staging). Input for v5.3.

## 21. How the cycle closes: the poll is the default, the webhook is a stub

Section 7 step 6 says `commerce.charge.paid` "dispara". The API delivers it through a trigger to a URL; a terminal kit has no URL the API can reach, and the five-minute contract cannot include exposing one. What the code does: the kit LOOKS. `GET /v1/charges/{id}` (which accepts the kit's own `idempotency_key` as the id) every three seconds through the core's `reconcile`, read-only on the rail, until `local_status` says `settled` or `expired`; the instrument is shown the first time a look finds it `payable`, the payer is told once, both marks in `state.db`. `channels/webhook/` is the other closer and is a STUB: the receiving contract (`X-CodeSpar-Signature: t=..,v1=hex(HMAC-SHA256(secret, "t.body"))`, body `{ id, type, source, occurred_at, data: { payment_id } }`), signature verification, dedup by event id, `npm run webhook` on localhost. Registering the trigger and exposing the URL are the developer's steps. Both paths are the same `ingestExternalEvent`/`reconcile` on the core, so the section 9 replay case holds for either. **v5.3:** say in 5 and 7 that the terminal closes by poll, and what `channels/webhook` is until WhatsApp.

## 22. First real charge cycle on staging: 10 s from issuance to `settled` (second attempt; the first stopped at the issuance)

**Measured, 2026-09-23 18:03:16Z**, staging (`https://api.staging.codespar.dev`, `org_demo`, project `prj_f1622489344f39fe`), replay provider, `npm start -- --scenario happy-path --mode human --rail api --wait 120`, after ent#1613 put Celcoin in the shared sandbox (deploy f75363dc). Everything after the model was real: the approval artifact, `POST /v1/charges`, the poll, the sandbox payer, the paid record. Execution `exe_624615ee1de452c5`, charge `9fa7974e-9d1c-452e-aa01-64e9272f4f52`, bundle `runs/run_20260923180317_human_c9efb4`:

| At (UTC) | What |
|---|---|
| 18:03:17.026 | `POST /v1/charges` (`idempotency_key att_eba3bcbfa0f0bd777d2a4260603d00d7_0`, `consumer_id merchant_demo_loja`) |
| 18:03:21.172 | `200`: `accepted`, `PROCESSING`, `payable: false`, no document (4.1 s) |
| 18:03:25.996 | second look: `PENDING`, `payable: true`, Pix copy-and-paste and boleto line present; the QR shown |
| 18:03:26.406 | `POST /v1/test/charges/{id}/pay` → `paid (full, 108000 of 108000), simulated=true, settled_against=sandbox_fixture, money_moved=false` |
| 18:03:30.342 | next look: `local_status: settled`, `settlement: confirmed` → `commerce.charge.paid` recorded, record saved |
| 18:03:31.161 | `executing → settled`; "Recebemos, acordo quitado" once |

**10 s from issuance to settled, 15 s for the whole scenario**, inside the forty of section 7. Two earlier charges of the day stayed open on staging: `0e88108e-45d4-48cc-ac93-ceb2491b2463` and `b3015c29-3082-4597-948d-c85b9dfe4f74`, issued by the two runs that found the walls in 31 and never paid (they expire on their due date, 2026-09-30).

The first attempt of the day (15:10:49Z) stopped at the issuance with `502 no_eligible_providers: eligibility_empty` (request `req_RC6k2TgcpavFACFs`): the demo org had no Celcoin connection (`z-api, unblockpay, stripe-acp, nfe-io, mercado-pago, melhor-envio, asaas`), Celcoin is the only issuer of the cobranca com vencimento, and eligibility is `META_TOOL_CATALOG ∩ connected_accounts`. The pay route was already live (`POST /v1/test/charges/chg_does_not_exist/pay` → `404 charge_not_found`, `req_5OwGqMnPGKLmOeV2`); the immediate Pix the org could mint (`pay_bor7b5ya822abgv9`, Asaas mock, `charge_url` only) is not readable back and not payable by that route. ent#1613 closed the wall with a shared-sandbox Celcoin lane and a receiver stand-in. **v5.3:** section 17 wave 2 can say "measured: 10 s on staging" with the precondition (the shared sandbox carries the bolepix issuer).

## 23. The charge call, as it really is

The spec names `codespar_charge` (7, step 4). What the kit calls is the REST twin `POST /v1/charges`, an adapter over the same strategy (`routes/charges.ts`), because the kit runs no MCP session: `{ amount, currency: "BRL", method: "boleto", description, buyer: { name, document }, due_date, idempotency_key }`. Four facts the spec does not state:

a. **`method: "pix"` cannot close a loop.** The meta-tool doc says it: an immediate Pix "is not readable or cancellable here" and "retrying an immediate Pix ... issues a new charge". Idempotency and a status read exist only for the cobranca com vencimento (`method: boleto` + `due_date`). So "bolepix-receivables" is the ONLY receivable the kit issues, à vista included: a payment in full is one bolepix with one due date, settled by Pix or by boleto. **v5.3:** 2 and 7 say "Pix à vista ou bolepix por parcela"; it is bolepix in both cases, paid by Pix.

b. **`amount` is in MAJOR units** (`coerceMetaChargeArgs`: `Number(input.amount)`, "R$ 125.00 → 125"), while the SDK's generated type for `POST /v1/charges` documents `amount` as "In minor units". The kit sends `amount_minor / 100` and compares the answer's `amount_minor` with what was approved; a mismatch withdraws the charge and fails the attempt (`amount_mismatch`) rather than leave a debt nobody approved. Core issue: the SDK doc string.

c. **`buyer.document` is required and validated** (check digit) for the due-dated charge. The kit's fixture debtors carry valid CPFs; the model never sees or passes one — the code takes it from the agreement.

d. **The create answers `PROCESSING` with `payable: false` and no document**; the instrument arrives on a later read (~30 s, up to an hour) or on `commerce.charge.created`. Step 5 of section 7 ("o QR chega") is a state the kit polls into, not the create's answer.

## 24. `charge.expired` closes as `failed`, not `expired`

Sections 8 and 12 say `charge.expired` → `expired`. The table of 4.1 has no `executing → expired` edge, and the type test keeps it closed. The kit closes `failed` with reason `charge_expired` (and `charge_cancelled` for `commerce.charge.cancelled`), which keeps `expired` meaning what 4.1 says: an OPEN execution that timed out before executing. **v5.3:** either add `executing → expired` to 4.1 or change 8 and 12 to `failed (charge_expired)`.

## 25. The receiving side has no signed policy; the mandate shape is reused

Section 16 already says the organization's collection policy "não existe e é candidata a produto". What the code does: `mandate.example.json` in the consumer-mandate shape, read by the same `MandateSchema`: `consumer_id` is the MERCHANT (the principal the agent acts for, `actor.on_behalf_of`), `merchant_pin_kind: "document"` (added to the enum), `merchant_allowlist` and `beneficiaries` are the DEBTORS with an open agreement, `per_tx_cap_minor` is the cap per receivable, `periodic_cap` the cap on what may be issued per month. The envelope (discount ceiling, instalments, due-date window, collection hours) is `guardrails.envelope`, run by the core as the kit's `policyExtension` at every gate (a person's yes does not widen it). There is no consent step and no API-side status to read, so revocation is the local stub only. **v5.3:** name the receiving-side policy fields in 4.3 or say the mandate shape is reused with these meanings.

## 26. Fractioning on the receiving side is refused, not escalated

Section 9 asks `must_escalate` by the velocity window. A receivable execution covers ONE agreement in full (its total must be at or above the principal minus the maximum discount), so "the agreement in five parts, one after the other" is five executions each below the floor: every one is `denied (outside_envelope)` before any window counts. The window and `escalate_above.amount` still apply to the whole (instalments inside one execution add up to the execution's total, and an agreement above R$ 3.000,00 asks the operator in `mandate`). The adversarial case expects `must_refuse` with `max_auto_settled_minor: 0`. **v5.3:** 9, row "Fracionamento": `must_escalate` on the paying side, `must_refuse` on the receiving side.

## 27. `new_beneficiary` and `outside_hours` are not escalation triggers here

`escalate_above` carries only `amount`. A receivable is issued against a debtor already in the book and the money comes TO the merchant, so "first charge to this debtor" is the normal case, not a risk (and with `new_beneficiary: true` mandate mode would never issue alone, section 6 again). Collection hours are a LEGAL rule (08:00–20:00 in `guardrails.timezone`), refused in BOTH modes by the envelope with reason `outside_hours`, not escalated. **v5.3:** say in 4.4 which triggers apply per side.

## 28. Events declared: the API's names, four of them

`events: [commerce.charge.created, commerce.charge.paid, commerce.charge.expired, commerce.charge.cancelled]` (plan §1: the API also publishes `payment_notified` and `expiry_notified`, which the kit does not consume: a notification is explicitly not a payment). The core's `ingestExternalEvent` maps `paid` → settled, `expired`/`cancelled` → failed, and the payout side's `commerce.payment.succeeded` / `failed` (section 20); the four charge names are constants in `packages/agent-core/src/events.ts`, the one list `npm run check` validates `events:` against.

## 29. Three receivables, one execution, one message

An agreement in N instalments is N `POST /v1/charges`, one per parcela, each with its own `due_date` and key (the API's own rule). The core keeps them as N attempts of ONE execution: `accepted` per attempt, `settled` when every attempt is paid, `failed` if any expired, `outcomes` naming each. The payer gets one message per outcome, deduplicated in `state.db`, whatever the number of looks or events. `due_date` is part of the `items_hash` when present: moving a due date after approval is another charge and goes back to `awaiting_approval`.

## 31. Three walls between "the charge exists" and "the cycle closes", found on the second staging run

a. **`consumer_id` is required on `POST /v1/charges`, and the SDK's typed body did not name it — CLOSED 2026-09-23 (#13).** The REST route has no session to default it from (`prepareBolepixIntent` reads `input.consumer_id`, else `ctx.agentId`, which a REST call does not carry); without it the shared-sandbox receiver stand-in is never engaged and the API refuses with "no Celcoin receiving identity", which reads like a missing account and is a missing field. The kit sends the policy's `consumer_id` (the merchant, `actor.on_behalf_of`), which used to need a cast at the call site. **Resolved:** `@codespar/sdk@0.16.6` types `consumer_id` on the create's body, the pin in `packages/agent-core/package.json` moved to it, and the `as unknown as` widening in `api/charge-rail.ts` is gone. What remains for v5.3 is the route doc, which still does not say the field is required.

b. **`GET /v1/charges/{id}` does not accept the caller's `idempotency_key` as the id**, against its own doc ("accepts EITHER the id the create returned OR the caller's own idempotency_key"): `GET /v1/charges/att_858db6e517d37d60e89b388694db4eec_0` → `404 charge_not_found` while `GET /v1/charges/0e88108e-…` answered the charge. The kit's lookup now goes by the charge id the create returned and falls back to the key only when no id was recorded (the create's answer was lost). A poll keyed on the key alone never sees the instrument register: that is what left the 17:54 run `executing`. Enterprise: either the read resolves the key or the doc stops saying so.

c. **`ApiClient.request` refuses a path outside its OpenAPI document**, so the payer route (not in `@codespar/sdk@0.16.4`) cannot be called through the client: "`POST /v1/test/charges/{chargeId}/pay` is not an operation of the OpenAPI document this client was generated from". The kit called it with a plain `fetch` against the same base URL, key (checked for `csk_test_` first) and project header. **Resolved:** `@codespar/sdk@0.16.5` publishes the route (and the deprecated alias), and `paySandboxCharge` is the client's typed `post` since the pin moved. `consumer_id` on the create's typed body (31a) is still open in 0.16.5; the cast at the call site stays.

Also measured: on the shared sandbox the instrument registers in about 5 s (PROCESSING at the create, PENDING and payable on the second look), and the paid state lands 4 s after the payer route answers. The GET after payment answers `status: "PENDING"` (the issuer's last known) with `local_status: "settled"` and `settlement: "confirmed"`; the kit decides on those two, never on `status`, which is what section 23 already said.

## 32. Things reality showed the spec got wrong (summary for v5.3)

- The terminal closes the cycle by poll; the webhook is a stub until there is a URL (21). The staging cycle first stopped at `eligibility_empty` (no Celcoin on the demo org), then measured 10 s from issuance to settled once ent#1613 landed; the immediate Pix cannot close a loop (22, 23a). `amount` in major units on `POST /v1/charges`, against the SDK doc (23b). The QR is polled into, not returned by the create (23d). `charge.expired` is `failed (charge_expired)` under 4.1 (24). The receiving side reuses the mandate shape and the envelope is code (25). Fractioning is refused, not escalated (26). Only `amount` escalates here; hours are law (27). Four charge events, the API's names (28). N bolepix, one execution, one message (29). `consumer_id` required and untyped, the read does not take the key, the SDK client refuses the payer route (31).

# The plugin and the skill (plan item 2.5), against spec v5.2

## 33. The gate, proven: a coding agent built `hello-agent` from `SKILL.md` alone, and the tree stayed green

**Run on 2026-09-23**, in a fresh clone on `feat/plugin-and-agent-builder-skill`, Node 25.5, no `ANTHROPIC_API_KEY`, no `CODESPAR_API_KEY`. The coding agent (Claude Code) read `skills/codespar-agent-builder/SKILL.md` and its three reference files and nothing else of the skill's, and built `agents/hello-agent`, the read-only kind: one local tool (`list_bills`), no `payment` or `charge` meta-tool, `maturity: {}`, `events: []`, `approval: [human]`, no `escalate_above`. What it produced and what the gates said:

| Gate | Command | Result |
|---|---|---|
| Manifest coherence | `npm run check` | `check ok: hello-agent agrees with its agent.yaml` (and the plugin half: `check ok: the plugin manifests, the skills and the rules agree`) |
| Section 9 suite + scenarios | `npm run eval --workspace=agents/hello-agent` | `eval ok: 7 adversarial case(s), 2 scenario run(s)`; every conversation case `states []`, `webhook-replay` `states ["settled"]` with `settled_once` |
| Types | `npm run typecheck` (with `agents/hello-agent/tsconfig.json` appended) | exit 0 |
| Suite | `npm test` | `Test Files 25 passed (25)`, `Tests 208 passed (208)` (hello-agent: check 8, adversarial 10, scenarios 4, cli 3, provider 2) |
| Secrets | `node scripts/secret-scan.mjs all` | `secret-scan: clean (all)` |
| One command | `npm start -s --workspace=agents/hello-agent -- --input "quais contas vencem em outubro?" --json` | `{"agent":"hello-agent@0.1.0","rail":"stub","actor":{"type":"agent","agent":"hello-agent@0.1.0","on_behalf_of":"usr_demo_titular"},"tool_calls":[{"name":"list_bills","refused":false}],"executions":[],"receipts":[]}` |

The seven adversarial transcripts all play the model that obeys the attack (five of them call `codespar_pay`, one calls `codespar_wallet` and `codespar_manage_connections`); every call is refused with `tool_not_allowed` before any handler, `tools_called` is empty, no execution exists. That is the read-only column of the section 9 table in `skills/codespar-agent-builder/reference/evals.md`.

**`hello-agent` is in the tree — CLOSED 2026-09-23 (#13).** The lane's rule was
to keep it only if it fit in 200 lines, and it was about 1,700: roughly 1,060
were the runner copied from `agents/bills-agent`, 240 its tests, and about 400
what the skill actually asks a coding agent to write. With the runner shared it
was rebuilt from the updated `SKILL.md` alone and is **300 lines** over every
file it owns — manifest, prompt, tools, guardrails, mandate, two scenario
packs, seven adversarial cases, the docs, `package.json`, `tsconfig.json` and
one 33-line `src/kit.ts` that spreads `defaultKit` and replaces two things, the
tool it offers and the `webhook-replay` case. `npm run check` is green and its
eval is 7 adversarial cases + 2 scenario runs, both in the CI. It ships no
`test/` directory: `check` and `eval` are its gates, and the runner's own
behaviour is covered by the two bigger agents' suites.

**What the run showed the skill, and what it leaves for v5.3:**

a. **The runner was copied per agent — CLOSED 2026-09-23 (#13).** Every agent
carried its own ~1,000-line copy of the eval runner, the terminal channel, the
setup and the commands, with a handful of agent-specific edits. That is why a
"200-line agent" was not possible. It now lives once, in
`packages/agent-runtime` (2,044 lines including the bin), behind one binary,
`codespar-agent <command>`, parameterised by the agent directory. What is
genuinely per-agent is one module, `src/kit.ts`, against the `AgentKit` seam:
the rail adapter, the tool handlers, the `policyExtension`, the console
labels, the one-shot JSON body, and for a receiving agent the sandbox payer
and the one message per outcome. Measured over `src/` plus `channels/`:
`bills-agent` 1,397 → 419 lines, `collections-agent` 1,874 → 483. Nothing else
changed: both agents' process-level tests, `cli.test.ts` and evals pass with
their expectations untouched (8 + 11 and 8 + 15), and the suite is the same 189
tests. `npm run check` now refuses `agents/*/src/main.ts`,
`agents/*/src/commands/`, `channels/` and a copied `setup.ts`, `scenarios.ts`
or `adversarial.ts` with `agent_carries_runtime`: "runtime-owned; delete it".
**v5.3 §5 (anatomy)** says which files are agent-owned and which are
runtime-owned; `skills/codespar-agent-builder/reference/anatomy.md` carries the
same two tables.

b. **The root names every agent twice.** `package.json` `typecheck` lists one `tsc -p` per agent and the CI's eval step lists one `npm run eval` per agent; `npm run check` and `npm test` glob. The skill's step 9 says to add both lines; a `scripts/typecheck.mjs` over the workspaces would remove the step.

c. **The section 9 expectations depend on the kind of agent**, and the spec's table states only the paying side. The reference file carries three columns (payer, collector, read-only), with the collector's from entries 26 and 27 above.

d. **The plugin formats, as verified on 2026-09-23.** Claude Code: `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` with `source: "./"`, validated with `claude plugin validate .` (`Validation passed`). Codex and Cursor both load the Agent Plugins standard (`plugin.json` with `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, `mcp.json`, `skills/`); Codex's repo-scoped marketplace is `.agents/plugins/marketplace.json` with `source: { source: "local", path: "./" }` (the doc says the path must start with `./` and stay inside the root; `./` itself was not exercised, the `codex` CLI was not available on the machine). Cursor's native manifest is `.cursor-plugin/plugin.json` (name, description, version, author) with `skills/`, `rules/` and `mcp.json` discovered from the root; the spec's `.cursor-plugin/marketplace.json` is Cursor's multi-plugin form and its schema page answered 404, so it is not shipped and a single-plugin repository does not need it. The plugin ships `rules/codespar-core.mdc` for Cursor and points every manifest at the root `AGENTS.md`. **v5.3:** name the Agent Plugins standard in 14.1 and drop `.cursor-plugin/marketplace.json` from the list.

e. **The MCP file has two spellings, and Claude Code reads only one.** Installed from the local marketplace (`claude plugin marketplace add <clone>`, `claude plugin install codespar-core@codespar`), `claude plugin details` counted `Skills (1) codespar-agent-builder`, `Agents (0)` (the kit agents under `agents/<name>/` are not read as subagents, and `agents: []` in the manifest says so anyway) and `MCP servers (0)` with `mcpServers: "./mcp.json"` AND with the same object inline; `MCP servers (1) codespar` only with the default `.mcp.json` at the plugin root. So the plugin ships both `mcp.json` (the Agent Plugins standard, for Codex and Cursor) and `.mcp.json` (Claude Code), byte-identical, and `check` refuses a split. **`mcp.json` carries no key.** `npx -y @codespar/mcp@0.5.8` reads `CODESPAR_API_KEY` from the environment and starts in setup mode without one (measured: `[codespar-mcp] no CODESPAR_API_KEY — starting in setup mode`). Env-var expansion syntax differs across the three tools (`${VAR}`, `${env:VAR}`, `${CURSOR_PLUGIN_ROOT}`), so the manifest does not try. `scripts/check-plugin.mjs` refuses a key-shaped value there and a pin that differs from `agents/bills-agent/agent.yaml`.

f. **The `.well-known/skills/index.json` catalog** of 14.1 lives on the web repository, not here; `npx skills add codespar/agent-starter-kits` reads `skills/` directly.

## 34. A gate that runs a one-shot must pin the clock: the hours guardrails read it (#16)

**Seen 2026-09-23 23:08Z (20:08 America/Sao_Paulo)** on PR #15: the CI gate "the receivable cycle closes in one command" went red with `denied (outside_hours) … agora sao 20:08`. Nothing in the PR touched the agent; `main` was green because it had run in the afternoon. The `collection_hours` envelope rule (27) is right; the gate was reading the wall clock, so between 20:00 and 08:00 São Paulo every PR failed it. The scenario runner never had the problem because it freezes its clock (`scenario.now`, default `2026-09-23T18:00:00Z`, ticking a second per read); the one-shot runner had no way to.

**Fixed:** `npm start -- --input … --now <ISO 8601>` (or `CODESPAR_AGENT_NOW` in the environment, which `setup()` reads so `approve`, `resume`, `poll`, `rerun` and `reconcile` honour it too) pins the clock `ExecutionEngine`, the stubs, the status gate and the loop already take as a dependency (`packages/agent-core/src/clock.ts`), for both agents; absent, the wall clock as before. The CI passes `--now 2026-09-23T14:00:00-03:00` to the collections one-shot, and the collections `cli.test.ts` sets `CODESPAR_AGENT_NOW` for every process it spawns, since `approve`, `resume` and `rerun` run the same envelope and were red at night for the same reason. The fixture's `due_date: 2026-09-30` reads the same clock, so the pin also keeps the gate green after that date. Tests: the collections one-shot at 20:08 BRT is `denied (outside_hours)` and at 14:00 `settled`; the bills-agent one-shot in `mandate` mode at 23:00 BRT on a payee the mandate already knows is `awaiting_approval` with trigger `outside_hours`, and at 14:00 runs alone.

**Same exposure, stated:** `bills-agent`'s `escalate_above.outside_hours` (`22:00-07:00`) reads the same clock. The bills gate runs in `human` mode, where every execution waits for a human anyway, so it is not exposed today; a gate that ever runs it in `mandate` mode near 22:00 must pass `--now`. The devcontainer job of #15 runs only the bills-agent replay in `human` mode, so it is not exposed; if it ever runs the collections one-shot, it passes the same flag. **v5.3:** say in 9 (gates) that a one-shot in a gate pins its clock.
## 35. What a first Codespaces run needs that the local path does not (plan item 2.4)

Section 14 asks for a devcontainer "so the five-minute contract holds without local Node". `.devcontainer/devcontainer.json` builds on `mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm` (Node 22.16.0 on 2026-09-23, above the 22.13 `node:sqlite` floor; no Dockerfile, the image is enough), runs `npm install` at the root and `git config core.hooksPath .githooks` on creation, and prints the quick path on every attach. The CI's `devcontainer` job builds the same file on the published image and runs the Node 22 check, `npm ci`, `npm run check` and the bills-agent replay happy path inside it. What differs from a local clone:

- **Keys come from the secrets UI, not from a file.** The local path copies `.env.example` to `.env`. In a Codespace the keys are Codespaces secrets (Settings > Codespaces > Secrets), which arrive as environment variables; `devcontainer.json` names `CODESPAR_API_KEY`, `ANTHROPIC_API_KEY` and `CODESPAR_API_URL` under `secrets`, so the creation page asks for them. No `.env` is needed, and the two never fight: `readDotEnv` (`agents/bills-agent/src/setup.ts`) sets a variable only when the environment does not already carry it, so a secret wins over a `.env` line. A secret added after the Codespace was created is injected on the next window reload (Codespaces restarts the terminal environment), not into terminals already open. Without any secret the run is the stub rail plus the replay provider, which is what the CI exercises: it prints a receipt, but not one the API knows.
- **The staging URL is a third secret.** Item 12 says a staging key needs `CODESPAR_API_URL`; locally that is a commented line in `.env.example`. In a Codespace it is set the same way as the key. A production key needs nothing.
- **No port, no proxy.** Verified against the code: the agent calls the API outbound over HTTPS (`api.codespar.dev` or staging), the terminal is the only channel, and the collections-agent's webhook receiver is a stub (item 21), so nothing listens and `forwardPorts` is empty. The day the webhook receiver is real it will need a forwarded port with public visibility, and a Codespace URL is not stable across restarts; that is a v5.3 question for item 21, not for this one.
- **The approval key and the local state live in the container.** `.codespar/approval.key` (item 3) and `state.db` are created on first use inside the Codespace's own file system, gitignored, and go away with it. A rebuilt Codespace signs its approval artifacts with a new local key, which is the stub's documented scope anyway.
- **The `git` identity is GitHub's.** A Codespace commits as the GitHub user, and the secret-scan pre-commit hook is installed by the post-create step, so a `csk_test_` value pasted into a file is refused there too.
- **Template repository.** Marking the repository as a GitHub template is a setting only the owner flips (`gh api -X PATCH repos/codespar/agent-starter-kits -f is_template=true`); "Use this template" and the Codespace both start from `main`, so a template copy inherits the devcontainer.

**Not yet measured:** a timed five-minute run from the Codespaces creation page to a verified receipt, by a lane without context (the same rule as 19c). The container build in the CI proves the image, the install and the replay path; it does not prove the wall clock of the first Codespace creation, which includes GitHub's own provisioning.
