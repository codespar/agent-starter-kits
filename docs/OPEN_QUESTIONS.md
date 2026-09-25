# Open questions and divergences from spec v5.1.1

Kept as the prompt asks: when the spec and the real API diverge, the code follows the API and the divergence is written here. Each entry names what the spec says, what reality showed, what the code does, and who decides. Input for v5.2.

## 1. `cli:` pin — the spec says `@codespar/cli@0.6.0`; npm publishes 0.13.0

`agent.yaml` pins `cli: "@codespar/cli@0.13.0"` (verified on npm on 2026-09-23; 0.6.0 is stale, and 0.12.1, the pin of the first delivery, predates the agent commands). 0.13.0 ships the three commands section 14.5 asks for, with the shapes its `--help` prints: `codespar agent run <dir> [--input <text>] [--approve|--deny]`, `codespar eval <dir>` and `codespar mandate revoke <id> [--reason <text>]`. The READMEs show them with `npx -y @codespar/cli@0.13.0`. The manifest schema accepts any exact version; the check only refuses an unpinned one. The `mcp` pin `@codespar/mcp@0.5.8` matches; `@codespar/sdk` is pinned at 0.16.8 in `packages/agent-core/package.json` (the spec's plan measured 0.16.2; 0.16.4 was the first pin, 0.16.5 added the sandbox payer route to the OpenAPI document, section 31c, and 0.16.6 types `consumer_id` on the charge create, section 31a). Decision taken 2026-09-23 (#3). Later the same day both pins moved to `@codespar/cli@0.14.0` and `@codespar/sdk@0.16.5`, the versions npm published that day; 0.14.0 adds `init --template bills-agent|collections-agent`. The sdk pin moved once more, to 0.16.6, with #13, to 0.16.7 with the typed receipt seal (§47), and to 0.16.8 with the organization kill switch on the mandate read (§4). **v5.2:** update section 14.4 and the example in 4.3.

## 2. `actor` has no field on the wire

Section 4.5 says every API call carries `actor`. `POST /v1/consumers/mandates/{id}/spend` and `POST /v1/consumer-payments/execute` carry `agent_id` and nothing else about who acts; the receipt (`GET /v1/consumers/receipts/{id}`) carries no actor either. What the code does: the spend sends `agent_id` (which the mandate binds, so attribution is the mandate's, not the caller's); the full `actor` object (`agent` + `on_behalf_of`, or `human` + `channel`) is stamped on every event of `events.jsonl`, on every approval artifact and on the local copy of every receipt. The CI checks the local copies. **Open:** does the API want an `actor` (or `on_behalf_of`) field on spend, and should the receipt carry it? Until then "actor on everything" is true locally and not on the wire.

## 3. Who signs the approval artifact — STUB

The API does not sign approval lists; its HMAC is the mandate proof and the receipt seal. The artifact of section 4.2 is signed with a local development key at `.codespar/approval.key` (generated on first use, mode 0600, gitignored), marked as a stub in `packages/agent-core/src/approval.ts` and in the READMEs. It proves what was approved to whoever runs the agent, and to nobody else. No third env var was added. Since wave 5 the RECEIPT carries an Ed25519 signature a third party can check (§47); the approval artifact does not, so this is now the one thing in the bundle that proves nothing outside the machine that wrote it. **Open:** an API-side signature (or Ed25519 with the agent key from KYA) so the artifact means something to a third party.

## 4. Revocation — CLOSED 2026-09-23 (#2); the organization kill switch — CLOSED 2026-09-25

Revocation never depended on the AgentGate: the consumer-mandate lifecycle is in the API today. `GET /v1/mandates/{id}` returns the allowance with its `status` (`active | paused | revoked | expired`) and `expires_at` (fourteen fields: `id`, `consumer_id`, `agent_id`, `display_name`, `purpose`, `merchant_allowlist`, `merchant_pin_kind`, `intent_note`, `cap_minor`, `per_tx_cap_minor`, `currency`, `status`, `expires_at`, `created_at`; measured on staging 2026-09-23 for `cm_aYHUpzAX3k39oFTn`), and `POST /v1/mandates/{id}/pause | resume | revoke` move it (`codespar mandate revoke <id>` in CLI 0.13.0). Note the spelling: the point read is registered ONCE, as `/v1/mandates/{id}`; `/v1/consumers/mandates/{id}` (the path issue #2 named) is not an alias and answers 404 — the SDK's OpenAPI says so, and staging confirmed it. What the code does: with a test key `ApiMandateStatusSource` (`packages/agent-core/src/api/mandate-status.ts`) reads that route before every `executing` and the engine executes on `active` only — `paused` → `denied` (`mandate_paused`), `revoked` → `denied` (`mandate_revoked`), `expired` (by status or by `expires_at`) → `expired`, and any read that does not answer (timeout, 5xx, 404, an unreadable body, a status outside the four) → `denied` (`mandate_status_unavailable`). Fail-closed: never "assume active". Without a key the same `MandateStatusSource` interface is answered by `packages/agent-core/src/stubs/mandate-status.ts` over the local state.db, which the `mandate-revoked` scenario drives, and `packages/agent-core/test/mandate-status.test.ts` drives the API source against a mocked HTTP server through the engine (paused, revoked, expired, 500, timeout, 404: `rail.pay` never called). **Still open:** a revocation reaches a running agent by the poll before `executing`, not by `commerce.mandate.revoked` arriving as a trigger.

**The organization kill switch. CLOSED 2026-09-25.** Until ent#1648 `org pauseAll` had no API surface and `org_paused` existed only in the stub. The API now has one switch per organization, and the kit reads it where it already reads the mandate. What was checked, and where:

- **The read.** `@codespar/sdk@0.16.8` types `GET /v1/mandates/{id}` with `org_paused: boolean` and `org_paused_at: string | null` next to `status`, read from `dist/generated/openapi.d.ts` of the published package. `status` stays the mandate's own: a pause changes no mandate, so a paused organization answers `status: "active", org_paused: true`. `ApiMandateStatusSource` reads the flag through a schema bound to that type (a renamed field fails `tsc`) and the engine denies on it before it looks at `status`: `denied` (`org_paused`), `rail.pay` never called. A read without `org_paused`, or with one that is not a boolean, is `unknown` and closes `denied` (`mandate_status_unavailable`). Absent never means "not paused". A deployment older than ent#1652 therefore stops every spend of this kit until it is updated. That is the fail-closed direction, and it is deliberate.
- **The spend.** A switch pressed between the read and the spend is refused by the API itself: every agent money door, including both spend routes the rail uses, answers 403 `org_paused` before anything is reserved (codespar-enterprise#1652, `docs/operations/org-kill-switch.md` in the enterprise repo). The rail already reported it as `failed` with that code; the engine now closes the execution `failed` (`org_paused`) instead of `failed` (`rail_failed`). It is `failed` and not `denied` because the execution was already `executing`, and the section 4.7 table closes an `executing` one as `settled` or `failed` only. Nothing moved either way.
- **The typing gap.** The SDK does not list `org_paused` among the 403 codes of the two spend routes. `POST /v1/consumers/mandates/{id}/spend` types `policy_denied | withdrawal_pin`, and `POST /v1/consumer-payments/execute` types `withdrawal_pin`. The rail does not branch on the typed union, so nothing breaks, but the document understates what the route answers. **Open, on the API side:** add `org_paused` to both 403 enums.
- **Pressing and releasing.** `POST /v1/orgs/{orgId}/pause` is in the public OpenAPI (a bearer key with the `organizations:pause` scope). The resume is service-only, needs a backend-verified admin, and is not in the public document. The kit presses nothing and resumes nothing: once `org_paused` is true, a person resumes the organization from the dashboard. Until then every new request is refused before `drafted` with `org_paused`.
- **How it was proven.** `packages/agent-core/test/mandate-status.test.ts`, on a mocked HTTP server through the engine: paused after approval, a read without the flag, a flag that is not a boolean, and a spend answering 403 `org_paused` in both body shapes the API uses (the documented `{ error: { code } }` envelope and the flat `{ error: "org_paused" }`). Each of these tests fails against the code before the change (checked by reverting it). **Not measured:** no run against staging with the switch pressed. That needs an admin to resume the organization afterwards, and this repository holds only test keys.

## 5. Spend by envelope, not by id (revised after the first receipt)

The brief expected `POST /v1/consumer-payments/execute` with `{ mandate, signature }`. The first design spent by id (`POST /v1/consumers/mandates/{id}/spend`) because the hosted consent never hands the envelope to a backend. On staging the by-id route refused the windowed mandate (§14b, ent#1606), so the kit now obtains the envelope through the partner surface (§16) and spends by envelope; by id remains the fallback for a mandate stored without one. **v5.2:** name both routes and when each applies.

## 6. `new_beneficiary: true` makes the first month look like `human` mode

With `escalate_above.new_beneficiary: true` (the example of section 4.3), the first payment to every named payee escalates in `mandate` mode. The happy-path therefore has the same trail in both modes (`awaiting_approval → approved → executing → settled`), which is what the "two modes, one trail" contract asks, and is also why the demo of "the agent runs alone" needs a payee that already has a settled payment (scenario `escalated-above-threshold`, turn 3). Not a bug: it is the ramp of section 4.4. **v5.2:** say so in 4.4.

## 7. Fractioning counts what the agent ran ALONE

Section 9 asks the window to catch five parts below the threshold. The velocity rule (`guardrails.velocity.window_hours`) sums, per payee, the mandate-mode executions the allowance approved without a human inside the window. A payment a human approved is not fractioning, so it does not count; otherwise "the following one, below, runs alone" (4.4) could never happen in the 24 hours after an escalated one. **v5.2:** state the rule in 4.4 or 9.

## 8. `tools.json` is the kit's shape under a meta-tool's name, not a snapshot of the MCP

Section 5 says the tools come from the MCP. They do not, and this entry used to say they were a snapshot of it written against the `mcp` pin. Neither half of that sentence held when measured on 2026-09-24, while scoping a `npm run tools:sync` that would diff `tools.json` against `@codespar/mcp@<pin>`.

**What `tools.json` is.** The closed list of tools the model sees, with an input shape each kit owns. A `meta_tools` entry borrows the name of a CodeSpar meta-tool so a reader knows what job it does, and its handler (`agents/<name>/src/modules/*.ts`) runs locally. A `payment` or `charge` tool calls `ctx.engine.draft(...)`, and `@codespar/agent-core` then builds the real call and sends it over REST (`/v1/consumer-payments/execute`, `/v1/consumers/mandates/{id}/spend`, `/v1/charges`, `/v1/consumers/receipts/{id}`). Nothing in the kit calls the MCP. The shape is narrower and different on purpose. The model names a payee alias and never a Pix key, an agreement alias and never a debtor's document, and the code resolves both.

**What the pinned package publishes.** `@codespar/mcp@0.5.8` ships no tool definitions. Its `dist/bin.js` answers `tools/list` with whatever `listTools(session)` returns, and `@codespar/sdk` fills that from the backend at runtime (`session.tools()` reads `payload.tools` from the connections call), which needs a key. The published definitions live in `@codespar/types` (`SHARED_META_TOOL_DEFINITIONS` in `dist/meta-tool-definitions.js`, each with an `input_schema` and a structural `contract` of properties, required fields and enums). The `mcp` pin does not name a version of it. `@codespar/mcp@0.5.8` depends on `@codespar/sdk` by range, which depends on `@codespar/types` at `^0.10.1 || ^0.11.0`, and the MCP's own bin does not read those definitions anyway. What the `mcp` pin actually names is the server the plugin's `mcp.json` launches for a coding agent learning the API (rule 10), not the source of the kit's shapes.

**The comparison, as evidence.** Each kit's `meta_tools` against `@codespar/types@0.11.3` (the version the SDK range resolved to on 2026-09-24), by the rules a `tools:sync` would enforce (tool gone, required field missing, field the tool does not accept, enum value the tool does not have):

| Kit tool | Agents | Published definition | Diverges |
|---|---|---|---|
| `codespar_pay` | bills, supplier-payments | `action` in `[pay, status]`, required `[action]`; `amount`, `currency`, `method` (`pix` is a method), `recipient`, ... | `action: pix` is not an action; `items`, `total_minor` and `batch_ref` (supplier-payments only) are not properties |
| `codespar_ledger` | bills, supplier-payments | `action` in `[entry, balance, account, receipt, receipts]` | `action: executions` does not exist; it lists this run's executions from the local engine |
| `codespar_charge` | collections | no `action` property; required `[amount, currency, method, description, buyer]` | the kit's shape has none of the five required fields; `action`, `agreement`, `instalments`, `total_minor` and `execution_id` are not properties |

`hello-agent` has only a local tool. Every tool name the kits use still exists in the published set. Every kit meta-tool fails the shape rules, and none of it is drift, because the two sides describe different layers.

**What is checked today.** `tools.json` parses against `ToolsFileSchema` (`packages/agent-core/src/tools.ts`: unique names, meta-tools named `codespar_*`, an `effect`), the prompt names no `codespar_*` outside it, and a call to a tool outside it is refused before any handler (`tool_not_allowed`, in every agent's adversarial suite). **What is not:** that the REST calls the core builds still match what the API accepts, or that the meta-tool names the kits borrow still exist upstream. **Open:** a check for that layer, which would read a pinned `@codespar/types` for the names and the SDK's generated OpenAPI types for the request shapes, never a live server. Whether to add it, and whether the kit's tools should keep borrowing meta-tool names at all, are product decisions; renaming them is not something to do in passing. **v5.2:** section 5 should say the tools are the kit's own and dispatched by the core, not taken from the MCP.

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

## 18. The receipt names no payee unless the spend carries a `quote` — CLOSED 2026-09-25: every spend carries one

`GET /v1/consumers/receipts/{id}` answered `quote: null`, so the receipt's payee was null; the payee is only on the receipt when the spend presents a `SpendQuote` (`seller`, `resource`, `price_minor`, `payee`, optional `session_id` and `at`). The kit did not send one, so the local receipt copy carried the payee from the execution, not from the seal.

**What the API does with a quote, read from the source and the SDK's OpenAPI rather than assumed.** The source is `codespar-enterprise` `origin/main` at `8571d364` (2026-09-24): `packages/api/src/routes/consumer-payments.ts` and `packages/api/src/agentic-receipt.ts`, whose line numbers below are that commit's. Both spend routes (`POST /v1/consumer-payments/execute` and `POST /v1/consumers/mandates/{id}/spend`) accept `quote` in `@codespar/sdk@0.16.6`'s typed body. The API binds it into the Control Record as its own link, between the mandate and the payment, signs it with the same consumer secret that signed the mandate (`quote.sig`, over seller, resource, price, payee and session id; `at` is in the link but not in that HMAC), and hashes mandate → quote → payment into `chain`. Five things differ from the one-line description above, and each changed what the code does:

- **Without a quote the payee is not in the chain at all.** The payment link carries rail, provider, `tx_id`, amount, `attempt_id`, `money_moved`, `sandbox` and `at`, and no payee (`PaymentLink`, `agentic-receipt.ts:248-272`). So a receipt sealed without a quote does not merely print `payee: null`: it never committed to a payee, and neither signature over it says anything about where the money went. Every kit receipt sealed before this change is that kind, and stays that kind.
- **The API compares the quote to the settlement in OBSERVE mode.** A quote whose price is not the settled amount, or whose payee (trimmed, lower-cased) is not the payee that was paid, is recorded on the receipt as an `exceptions` entry (`price_mismatch`, `payee_mismatch`) with `state: exception` — and the money still moves (`detectQuoteExceptions`, `agentic-receipt.ts:374-397`). The API's comment names an ENFORCE mode as future work (`agentic-receipt.ts:372`); nothing on `main` implements it. `exceptions` is stored and read back but is not a link of the chain, so no signature covers it. Both are filed as [ent#1650](https://github.com/codespar/codespar-enterprise/issues/1650). So the refusal is the kit's: it compares exactly, before the call.
- **The quote does not change what `npm run verify` checks.** The Ed25519 signature still covers `codespar-receipt:v1:<receipt_id>:<chain>`; the quote changes the chain's value, not the signing string. What changes is what the digest covers: from now on the payee is inside the hash the signature attests (§47).
- **The sealed payee comes back exactly as it was sent.** The trim-and-lower-case is the guard's own comparison and nothing else: `normalizePayee` (`agentic-receipt.ts:366`) is called only at `agentic-receipt.ts:389`. The value itself goes from the body into the quote input verbatim (`consumer-payments.ts:2787`), into the link and the quote's HMAC as is (`agentic-receipt.ts:301`, `:339`), into a plain `text` column (`quote_payee`, migration `0093`, written at `agentic-receipt.ts:719`) and back out of `GET /v1/consumers/receipts/{id}` untouched (`receiptRowToJson`, `agentic-receipt.ts:1032`). That is why the kit's own receipt check compares exactly: a mixed-case e-mail key the kit sent is the key the receipt returns. If the API ever starts storing the normalized form, a correct payment to such a key will raise `ReceiptSealMismatchError`, and the fix is to compare with the API's normalization, not to soften the error.
- **`quote` is null when the receipt carries neither a seller nor a resource**, and a spend whose consumer secret the API cannot resolve is sealed with no receipt at all. The second is not new and the kit already treats a missing receipt id as "nothing to fetch".

**What the code does.** `ExecutionEngine.paymentsFor` builds each attempt's quote from the approval artifact's line at the same index — the list its `items_hash` covers, never the model's words after approval: `seller` is the line's beneficiary (the mandate's name for the payee, or the raw key when it has none), `resource` the line's description or else the mandate's `purpose`, `price_minor` the line's amount, `payee` the pinned key, `at` the artifact's `approved_at`, so a retry under the same `attempt_id` presents the same quote byte for byte. Every agent that spends goes through that one function: `bills-agent` and `supplier-payments-agent`'s `batch-payout` (one execution, one artifact and one quote per line). `hello-agent` spends nothing — its only tool reads — and `collections-agent` receives: the charge rails ignore the field, and a receivable seals nothing.

- **A quote that would disagree is refused locally, before the call.** At the last gate, inside the transaction that writes the outbox row, a quote whose `price_minor` is not the amount about to be spent, or whose `payee` is not the payee about to be paid, closes the execution as `denied` (`quote_mismatch`) and nothing is sent. The artifact check before it already makes that unreachable for an honest artifact; the gate exists because the quote is read from the ARTIFACT's items and the payment from the execution's, and an artifact whose items disagree with its own `items_hash` is a writer bug the hash check alone does not see. `CodeSparRail.pay` makes the same check again and refuses a spend with no quote (`quote_missing`) without calling the API; the stub rail makes the same refusal, so no scenario passes without one.
- **The local receipt copy takes the payee from the seal.** `CodeSparRail.receipt` reads `quote.payee` and nothing else; the stub rail does the same over the quote it was handed, and seals no payee for a spend that carried none, like the API.
- **A sealed payee that is not the payee paid is an error, not a warning.** When a payment's receipt seals a different payee, or none, the engine writes the copy as sealed, records `receipt.seal_mismatch` (both payees masked with `maskPayee`), saves the execution's outcome — the money is where the rail says it is — and then throws `ReceiptSealMismatchError`. The tool call that paid fails instead of reporting `paid: true`. Nothing new is written unmasked: the event masks both keys, and the receipt copy masks as it always has (§37).

**Measured, and not.** Tests that fail without the change: the quote is the approved line (two items, one with no description); a spend without a quote is refused by both rails with no HTTP call; a drifted artifact is `denied` with zero rail calls; a receipt sealing another payee, or none, throws after the outcome is saved; every line of a batch presents its own line's quote and its receipt copy carries that payee. Removing the quote from `paymentsFor`, or the comparison from the receipt step, turns them red. The scenario matrix is unchanged, 41 runs. **Not measured on staging**: no test key was configured where this was built, so no receipt was sealed with a quote against the live API. **Open:** one staging spend showing `quote` non-null and `exceptions: []` on the receipt, which is also the first receipt whose chain covers the payee.

## 19. Things reality showed the spec got wrong (summary for v5.2)

- CLI version (1). `actor` on the wire (2). Who signs the approval list (3). Spend by envelope, because by id fails with `periodic_cap` (5, 14b). `new_beneficiary` and the first month (6). Fractioning counts only autonomous runs (7). `approval.json` is a list (9). `outside_hours` is a closed window in a named timezone (11). Five minutes measured on staging, with a third env var (12). Window cap strictly below lifetime cap (14a). `npm install` at the root (15). Hosted consent cannot hand a terminal kit the envelope; partner surface in the sandbox (16). `/v1/test/fund` is Celcoin-only (17). Receipt payee needs a quote, and without one the chain carries no payee at all (18, closed: every spend sends one). `commerce.payment.settled` is not an API event; `succeeded` is (20). Revocation is in the API, not in the AgentGate; the point read is `/v1/mandates/{id}`, with no `/consumers/` alias (4).

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

## 36. `verify.json` stays unwritten, and the reason is not "not done yet"

Section 11 lists seven files in the proof bundle. Six are written; `verify.json` is not, and this section is what `npm run inspect` points at instead of leaving the absence to be guessed at.

`verify.json` is defined by the spec itself as "a saída de `codespar audit replay` para o intervalo do run: a mesma verificação de hash chain da CLI, gravada no bundle, **sem uma segunda implementação**" (section 11). Section 14.5 records that `audit` is not a registered command of `@codespar/cli` — the registered list the spec records is `charge`, `connect`, `create`, `init`, `issue`, `ledger`, `list`, `login`, `logout`, `logs`, `mandate`, `servers`, `sessions`, `ship`, `spend`, `tail`, `tools`, `whoami`, plus the agent commands 0.14.0 added — and section 14.6 puts `audit export` / `audit replay` under "trabalho na CLI, sem prazo".

So there are exactly two ways to produce the file, and the spec closes both:

- **Shell out to `codespar audit replay`.** The command does not exist. A bundle writer that calls it would fail on every run, and gating it on "if the CLI happens to have it" makes the bundle's contents depend on which CLI version is installed, which is the opposite of what a proof bundle is for.
- **Verify the chain locally.** That is the second implementation the spec forbids, and the prohibition is the right one: two implementations of a hash-chain check that disagree is worse than one that is absent, because the bundle would then carry a verdict nobody can trace to the verifier of record.

What is written instead: nothing, and `inspect` says so. Every rendering — terminal, `--json`, `--html` — carries `verify.present: false` and a one-sentence note naming `codespar audit replay` and the prohibition. `ProofBundle.hasVerify()` exists and reads the file, so a bundle that gains one the day the CLI ships the command is noticed rather than ignored; nothing in this repository writes it.

**Decides:** whoever schedules `audit replay` on the CLI. Until then the receipt's own `chain` field is in the bundle (`receipts/*.json`), unreplayed, which is the honest state: the chain is recorded, and the check that would confirm it has no home yet. Since wave 5 that chain is SIGNED — `npm run verify` proves CodeSpar sealed this receipt id with this chain — which is a different claim from replaying the audit interval, and does not close this section (§47). **v5.3:** say in section 11 that `verify.json` is conditional on the CLI command, rather than listing it beside six files that always exist.

## 37. What `npm run inspect` needed that the bundle was not writing (wave 3)

Building the timeline of section 11 measured the bundle against the question it is supposed to answer, and found three gaps and one leak. All four are fixed in `packages/agent-core` (`ProofBundle`, `ExecutionEngine`) with tests in `packages/agent-core/test/bundle.test.ts`.

a. **The rail's answer was a status and nothing else.** `rail.outcome` recorded `attempt_id` and `status`, plus `code` on a refusal. The transaction id, the receipt id and whether money moved were only ever recoverable by joining a later `commerce.payment.succeeded` event, and on a refusal the rail's own message was written only for an `uncertain` outcome, never for a `failed` one — so "what did the rail say" could not be answered from the line that recorded the answer. Now `rail.outcome` carries `transaction_id`, `receipt_id`, `money_moved` and `sandbox` when the rail took the attempt, and `code` plus `message` when it refused. It deliberately does NOT carry the outcome's `raw`: that is the provider's own echo, and the bundle makes no promise about what a provider puts in it.

b. **The call that went out did not name its idempotency key.** The key was in the `approved -> executing` transition's `detail`, as prose (`"idempotency_key idk_…"`). It is the correlation that makes a retry the same payment rather than a second one, so `rail.dispatch` now names it as a field.

c. **`run.json` named the mandate and not the version.** Section 11 says "modo, trilho, id do mandato", and the version was one file away in `mandate.snapshot.json`. Since "under which version of the mandate" is one of the four questions `inspect` exists to answer, `run.json` carries `mandate_version` beside `mandate_id`.

d. **`receipt.saved` recorded an absolute path.** Every bundle written on a developer's machine carried `/Users/<name>/…/runs/<run-id>/receipts/<id>.json` in its event log: not a secret, but the machine and the account of whoever ran the agent, in a folder whose whole purpose is to be handed to somebody else. `ProofBundle.receipt()` now returns the path inside the bundle (`receipts/<id>.json`) and that is what is recorded.

**Still raw on disk, masked on the way out, and left that way on purpose.** `events.jsonl` and `approval.json` hold the payee key unmasked, while `mandate.snapshot.json` and `receipts/*.json` mask it. Two reasons not to change it in this wave:

- `agents/bills-agent/src/kit.ts` `rerunPlan` reads the raw `payee` out of `rail.dispatch` to tell the stub rail which payee to refuse, so `npm run rerun` of a run with a refused payee correlates on that exact value. Masking the field breaks the replay of a refusal, which is a contract of section 10.
- `approval.json` carries `items_hash`, the hash of the canonical list. Masking the items in the bundle copy would leave a file whose hash cannot be recomputed from its own contents. (The spec's own artifact shape in section 4.2 lists `beneficiary`, `amount` and `currency` and no `payee`, which suggests the cleaner fix is at the artifact, not at the bundle writer.)

What `inspect` does instead: it masks on the way out, with the bundle's own `maskPayee`, which is idempotent on its own output so a value the snapshot already masked passes through unchanged. It masks the payee field AND the free text around it, because an escalation detail names the payee it escalated on (`first payment to Escola Aurora (financeiro@…) under this mandate`) and masking the field alone would leave the key readable one line below. It also reports the conversation as counts and never as text: `transcript.jsonl` holds a debtor's own words, and a timeline meant to be handed over is not the place to re-publish them. **Open, for whoever owns the artifact:** drop `payee` from the approval artifact's items (section 4.2 already omits it), then mask the event log's payee and give `rerunPlan` the attempt id to correlate on instead. **v5.3:** say in section 11 which files mask and which do not, rather than "o bundle … mascara dados pessoais" over the folder as a whole.

## 38. Scenario coverage against the section 12 table, measured (wave 3)

`npm run scenarios` (`scripts/scenario-matrix.mjs`) runs every scenario of every agent in every mode it declares, through the replay provider and the stub rail, and fails on a wrong final state — the states, trails, reasons, escalation triggers and receipt counts the scenario file declares, never the wording of a reply. It discovers agents from `agents/*/agent.yaml` rather than listing them, so a fourth agent is in the matrix the day it lands. The CI runs it as its own step beside the three `npm run eval` calls.

**Today: 28 runs across three agents, all green.** Against the section 12 table, minus `partial-batch-failure` (which section 12 itself assigns to the `supplier-payments-agent`, another lane's):

| Agent | Of the table | Extra | Missing |
|---|---|---|---|
| `bills-agent` | 6/7 | — | `charge-expired` |
| `collections-agent` | 7/7 | `instalments` | none |
| `hello-agent` | 2/7 | — | `cap-exceeded`, `beneficiary-not-allowed`, `charge-expired`, `escalated-above-threshold`, `mandate-revoked` |

Neither gap is a gap. `charge-expired` is a receivable expiring, which a payer agent cannot have; section 12 already marks it "Do `collections-agent`". `hello-agent` is read-only and cannot pay, so it has no cap to exceed, no allowlist to violate, no threshold to escalate past and no mandate whose revocation would change anything — its two scenarios are the two that mean something for an agent that only reads. The matrix therefore PRINTS the coverage and GATES on the final states, rather than requiring a row an agent cannot honestly have.

**The clock:** every scenario file pins its own instant (`scenario.now`, default `2026-09-23T18:00:00Z`, ticking a second per read), so the matrix reads the same at 03:00 as at 15:00 and needed no `--now` of its own — the exposure of section 34 is on the one-shots, not here. The bills one-shot in the CI is left without a pin deliberately: `escalate_above` is evaluated only in `mandate` mode (`ExecutionEngine.policy`), and that gate runs in `human`.

## 39. What building `supplier-payments-agent` and `batch-payout` showed (wave 3)

a. **"Um lote é um laço de execuções" is load-bearing, and the alternative was measured.** Section 2's sentence reads like phrasing; it is the design. The other reading — one execution carrying N items — was tried on the stub rail before anything was written: a four-line payout whose second payee the rail declined ended with the execution `failed`, one payee paid, and **the two lines after the refused one never dispatched at all**, because `ExecutionEngine.dispatch` breaks out of its attempt loop on the first `failed` outcome and `close()` only settles when every attempt settled. For a payroll that is two people unpaid because one supplier's key was wrong. One execution per line gives each line its own `idempotency_key`, its own `attempt_id`, its own approval artifact and its own terminal state. **v5.2:** say in section 2 that the multi-item execution is not an implementation detail a kit may choose, and why.

b. **A batch needed one primitive the core did not have, and the reason is the seam.** `ToolContext` is `{ engine, onExecution }`, so a tool handler's only durable surface is the engine. Execution ids are random, so a second run of the same batch mints fresh ids, fresh idempotency keys and fresh attempt ids, and the rail's own idempotence — keyed on `attempt_id` — would not recognise them as the same payment. `ExecutionEngine.claim`/`claimed` was added over the cursor table `markShown` already uses: it records which execution covers a key, and reads nothing into it. The rules are the kit's, and they match the posture the enterprise money paths take (`transfer_in_progress` / `transfer_failed`): settled is skipped, still-open is never re-opened, and only an execution that ended without moving money is retried. **Open:** whether that belongs on the engine at all, or whether `ToolContext` should carry a narrow key-value surface of its own. The engine was chosen because it is the object the handler already holds.

c. **The claim is local, and that is a real limit, not a stub.** It lives in `.codespar/state.db`. Delete that file and the agent has no memory that a batch ran; the rail's idempotence does not save it, because the re-run's attempts carry new ids. So "repetir não paga duas vezes" is true for a kit running on one machine against its own state, which is what a kit is, and is NOT true across two machines running the same batch. **Open:** does a batch want a caller-supplied batch idempotency key the API recognises, the way `POST /v1/consumers/:id/wallet/transfer` requires `idempotency_key`? That would move the guarantee to the server and make it true for any number of callers. Named here because the README claims the property and must not claim more of it than the mechanism has.

d. **A scenario pack could not script the one failure a batch exists to survive.** Section 12's `partial-batch-failure` needs the RAIL to decline one payee: an allowlist refusal never reaches the rail, and a cap refusal is not what a partial batch failure means. `RailContext.stubRail` existed and its own comment already named "a scenario" as a caller, but `ScenarioSchema` had no way to fill it. Added as `stub_refuse_payees`, empty by default. **v5.2:** list it with the other pack hooks in 12.

e. **`approval: human` on a batch asks N times, and section 3 says it should.** "O agente monta; o humano aprova **cada um**" is unambiguous, and the channel hook (`onExecution`) fires per execution, so three payroll lines are three questions. This is a feature at a keyboard — an operator can approve two lines and deny the third, which is exactly what they want when one line looks wrong — and it is a problem at scale, because nobody clicks `s` forty times for a real payroll. The one-shot and the scenario runner pass one decision to every line, so the gates do not feel it. **Open for v5.2:** does a batch want a single "approve the whole list" gesture that still mints one artifact per line? The artifacts are already the list; only the asking is one-at-a-time. Since #21 they also SAY which list they are, so such a gesture would be attested rather than asserted — see §40.

f. **`embedded-consent` is not shipped here, deliberately, and the spec's "os três importam os mesmos módulos" has no mechanism.** That module is the partner surface for a CONSUMER authorizing a mandate over their own money, with an `in_person` attestation from the person at the keyboard. The mandate behind a payroll is the company's and is minted by whoever owns finance, so a terminal consent would be the wrong story and the wrong attestation. The deeper point: there is today no way for two agents to IMPORT one module. Each agent owns `src/`, `check` refuses a copied runner, and an agent that wants the bills-agent's consent has to duplicate its 125 lines. **Open:** a shared `packages/agent-modules` for the pieces more than one agent wants, or an explicit statement that duplication is the intended cost of an agent being a readable directory.

g. **Two things the skill got wrong, both now fixed in it.** `reference/manifest.md` pinned `cli: "@codespar/cli@0.13.0"` in its example while `agents/bills-agent/agent.yaml` carries `0.14.0`; the skill says to copy the anchor's value, so the stale example was a trap for anyone who copied the reference instead. And neither `SKILL.md` nor `reference/anatomy.md` said what a `src/modules/<module>.ts` is FOR — `anatomy.md` listed the path and nothing else — although both shipped agents organise their handlers that way and section 2 names the modules as the unit the agents share.

## 40. Two shapes for a batch, and which one a kit should reach for (material for v5.3)

Section 2 says "um lote é um laço de execuções sob um mandato"; section 4.1 and section 15 describe one execution with N items. The two readings were treated as one phenomenon tested two ways. They are not: they are two shapes with different properties, and after the dispatch fix in this PR **both work**. What follows is what each one actually gives you, measured rather than argued, so section 5 of v5.3 can say which to reach for instead of leaving a builder to infer it.

**One execution, N items.** The list is ONE object: one approval artifact carrying `items[]` and one `items_hash` over the whole list, which is section 4.2 exactly. A person approves the list as a unit, and what is attested is the list. One `idempotency_key`, one `attempt_id` per item, one terminal state for the lot. Partial failure is named inside it: `outcomes` names every item, and the execution closes `failed` if any attempt failed — after this PR, without dropping the items after the first refusal.

**N executions, one per line.** Each line is its own execution with its own `idempotency_key`, `attempt_id`, approval artifact and terminal state. A refused line is a terminal state of its own row and the siblings are untouched. Re-running is per line, so line 57 with a wrong key is fixed and re-run ALONE, without re-approving the other 199. In `approval: human` a person decides each line, which section 3 asks for in so many words ("o humano aprova cada um") and which lets an operator approve four and deny the fifth.

**Reach for one execution when the list is approved as a unit** and is small enough for a person to read in one go: "pague as contas de outubro". The `bills-agent` is this shape, and its four bills are one decision.

**Reach for N executions when each line is independently approvable and the batch can be large**: a payroll, a supplier run, a commission cycle. The `supplier-payments-agent` is this shape. A 200-line payroll as one execution is one all-or-nothing decision over a list nobody reads, and one wrong line sends the whole list back through approval.

**What the second shape cost — CLOSED 2026-09-24 (#21).** It cost the SET. Each line was attested by its own `items_hash`, and a person who approved four lines while the agent ran three was left with a bundle that did not say a fourth existed; the skipped line appeared only in the tool's own report, which lives in `transcript.jsonl` — the model's conversation, not the attested record. What closes it: the list is hashed ONCE, before any line is drafted, with `batchHash` — which is `itemsHash` over the whole ordered list and deliberately not a second canonicalisation, so a reader who concatenates the lines gets the batch's hash back — and every artifact of the batch carries that hash with the line's own `index` and the list's `count`. `inspect` prints the header once and reads a partial batch back as `2 of 4 line(s) attested · 3 with an execution · no execution for line(s) 3`.

Two things the fix had to keep apart, because they want opposite answers. A line the human DENIED is a decision and is reported: it has an execution, no artifact, and the counts still add to the four presented. A line that left the LIST after the list was approved is a changed set, and the next run of that `batch_ref` is refused before it drafts anything — the surviving lines would each answer `already_settled` on their own, so nothing per-line would have noticed. The binding is durable through a `batchset:` claim naming the first execution the ref ever drafted; the per-line claims could not carry it, because the claim of a dropped line is never read again.

**Still open, and named because the README must not claim more than the mechanism has.** `batch_hash` binds the list to the artifacts, not to the payables file. A list edited BEFORE it was ever presented is simply the list, and the mandate's allowlist and caps are the only thing between it and a payment. And the binding is local, in `.codespar/state.db`, with the same limit as the per-line claim in (c) above: delete that file and there is no approved set to contradict.

**And what it now makes honest.** §39e asked whether a batch wants a single "approve the whole list" gesture that still mints one artifact per line. `batch_hash` is what would make that gesture truthful — the artifacts already ARE the list, and now they say which list — so the question is no longer blocked on the attestation and is only about the asking. Still open for v5.2.

**What both shapes need from the core, and now have:** every attempt is dispatched and every attempt is named (this PR). Before it, the one-execution shape silently dropped the items after the first refusal, which is why the choice looked like a choice between "the list is attested" and "a refusal does not stop the others". It was never that; it was a defect in `dispatch`.

**v5.3:** say both in section 5, with the rule of thumb above, and drop the implication in section 12 that `partial-batch-failure` and "falha parcial multi-item" are the same test written twice — they are the same PROPERTY in two shapes, and a kit declares which shape it is.

# The WhatsApp channel (wave 4), against spec v5.2

Same rule. Entries 41 to 46 come from building `channels/whatsapp` and
running it against a local Cloud API emulator on 2026-09-24. Input for v5.3.

## 41. Where a channel lives: the runner owns the behaviour, the agent owns the conversations

Section 5's anatomy table puts `channels/terminal/` and `channels/whatsapp/`
inside an agent. Since the #18 refactor the runner owns channels — one
`terminal.ts` serves all four agents, and a second copy of it per agent is the
thing that refactor removed — so a per-agent `channels/terminal/` would be an
empty directory whose only job is to match a table.

What the code does: the BEHAVIOUR is `packages/agent-runtime/src/channels/`
(the seam, the rules, the WhatsApp adapter, its two backends), and what an
agent ships under `agents/<name>/channels/whatsapp/` is the CONVERSATIONS —
one JSON file per conversation, naming the contact it is bound to, the
agreement it may be about, and the person's turns. That is the half a runner
cannot have: which debtor, which number, which agreement.

`npm run check` reads the split in both directions (`channels_not_shipped`,
`channels_undeclared`, `channels_script_invalid`, `channels_terminal_missing`),
so `channels: [terminal, whatsapp]` is a claim about files rather than a label.
The schema for a conversation is in the core (`packages/agent-core/src/channels.ts`)
next to the manifest and the guardrails, because the check parses it and the
core is what the check can import.

A third thing lives outside both: the EMULATOR the channel talks to, which is
somebody else's package at a pinned version. See §42.

One correction that belongs here: §21 and the `collections-agent` README call
the webhook receiver `channels/webhook/`. There is no such directory and there
never was — it is `packages/agent-runtime/src/webhook.ts`, reached by
`npm run webhook`. Now that `channels/` means something specific the wording
would mislead, so the README says the path. **v5.3:** section 5 should say
where each half lives, and drop `channels/webhook/` as a path.

## 42. The house simulator is somebody else's, and that is the point

The first cut of this lane wrote its own simulator. It was replaced, before
that code was a day old, by `dyvit-wa-sim` — the local Cloud API emulator in
[fabianocruz/whatsapp-simulator](https://github.com/fabianocruz/whatsapp-simulator),
MIT — and the reason is worth stating because it applies to the next seam too.

**A mock we write agrees with us by construction.** It accepts the payloads we
send because we wrote both sides, and the day Meta refuses one of them we find
out in production. The emulator answers
`POST /v{version}/{phone-number-id}/messages` with the Cloud API's own response
shape and posts back the same `x-hub-signature-256`-signed webhooks, so the
`simulator` backend is now literally THE SAME CODE as the official one with a
different base URL (`live` is derived from the host, not from a flag). That is
the thing worth proving, and a mock cannot prove it.

It is not a dependency of this workspace: it is a development tool nothing in
`packages/` or `agents/` imports, so `npm ci` has no reason to fetch it and a
contributor who never runs the WhatsApp gate never downloads it. Until
2026-09-24 it could not have been one anyway — its packages 404'd on npm and it
is a pnpm workspace while this repo is an npm one — so this lane kept a CLONE AT
A PINNED SHA in a cache directory. The CLI went up that day, and
`scripts/whatsapp-emulator.mjs` and the one CI step now run
`@dyvit/whatsapp-simulator-cli` AT A PINNED VERSION through `npx`, which caches
it outside the tree. Pinned because a moving `latest` would fail our gate on
somebody else's release. A cache directory left by the old mechanism
(`~/.cache/codespar-whatsapp-simulator`) is dead and can be deleted by hand.

**CLOSED, and worth keeping as the one finding that got fixed.** 0.1.0's
published bin was a no-op: `dist/cli.js` ran `main()` only when
`import.meta.url` equalled `pathToFileURL(process.argv[1]).href`, and a bin is
a symlink that Node resolves on one side and not the other, so through `npx`
the two never matched — `npx … serve` exited 0 having started no server, which
is the worst shape a failure can take: a command that passes and a port that is
dead. We reported it rather than patching around it for good, and **0.1.1
fixes it** with a `realpathSync` on `argv[1]`, covered upstream by a test that
packs, installs and runs the bin. So the script simply calls the bin again, and
the path-resolution workaround this lane carried for one version is gone. The
same rule applied to the five gaps in §46, and 0.2.0 closed all of them, which
is the argument for reporting them. The pin is now 0.2.0.

Two things remain STUBS on our side and are named rather than implied.

a. **Template approval.** A template is registered in a Meta Business account,
reviewed by Meta and given a status no call of ours can read without that
account — and the emulator does not model it either. What the channel holds is
the LOCAL registry: the template names the agent declares. Sending one that was
never declared is refused here instead of 400-ing at Meta. Whether Meta
approved it is the developer's to check.

b. **The QR as an image.** Sending an image means uploading it first
(`POST /{version}/{phone-number-id}/media`, multipart) or handing a public URL.
This repo hosts nothing and renders no PNG, so `buildSendRequest` answers
`media_upload_unimplemented` and the channel sends the copy-and-paste as its
own text message, which is the string that actually pays. Worth recording
precisely: **the emulator would take it** — `type: "image"` with an `image.link`
answers 200 — so the blocker is OURS, not its. The concrete option is to serve
the QR from the receiver the channel already runs
(`http://127.0.0.1:<port>/qr/<id>.png`), which needs a PNG encoder; against
Meta that URL has to be publicly reachable, which is a deployment question and
not a code one. **Open:** do that, or accept that on WhatsApp the copy-and-paste
is the payable artifact and the QR is for a second device.

c. **The secrecy rule's reach is the alias, and only the alias.** "A message
may not name another debtor's agreement" is enforced by comparing the message
against the aliases the agent has conversations for (`acordo-1042`,
`acordo-1103`), which is the set the runner can see: the debtors' book is
`src/agreements.ts` and the runtime does not read an agent's source. So a
message carrying `acordo-1103` into Joana's conversation is refused, and "o
Carlos tambem deve" is not. That is a real limit and not a bug to fix in the
channel — deciding whether a sentence discloses somebody's debt is the prompt's
job and the operator's, exactly like "no embarrassment". **Open:** should an
agent declare its subjects somewhere the runner can read (a `subjects` key on
the guardrails envelope), so the rule covers the whole book rather than the
conversations that happen to be shipped?

And the whole official backend is written against Meta's published
documentation and has never been run against Meta from this repo. The pure
half — the signature check, the webhook parse, the verification handshake and
the request builder — is under test; the send is one `fetch` over a request
those functions built. The READMEs say this in those words.

## 43. Consent in the conversation (decision 19a): the seam is wired, and a simulator may not use it

ent#1615 landed `attestation.evidence` on `POST /v1/consents/{token}/submit`.
For the `whatsapp` channel the API accepts exactly four keys beside `channel`
— `contact`, `message_id`, `session_id`, `provider_ts` — and refuses `ip`,
`user_agent`, `device_id_hash` and `geo` with 400 `attestation_evidence_invalid`,
because a conversation hands a partner a message and a sender, not a socket.
The wire carries `contact` in the clear and the API hashes it into
`contact_hash` under the org's own key, which a partner cannot compute.

`channels/whatsapp/evidence.ts` builds that object and mirrors the rule, so a
mistake fails in this repo instead of failing as a 400 at the submit.

**It refuses to build one from the simulator, and that is the answer to the
question the wave asked.** Everything in the object is a claim about what a
provider observed. A simulated conversation was observed by nobody: the message
id is a counter, the timestamp is this process's clock and the contact is a
fixture. Signing that would be the same false declaration the API's own schema
warns about for a partner that declares `other` for a WhatsApp act. So
`evidenceFor` returns a refusal with the reason on it, and the simulator's ids
are `sim_...` so nothing downstream can mistake the two.

**Two things still stand between the seam and a mandate born in a chat, and
neither is this lane's to close.** The `collections-agent` has no consent step
at all — the MERCHANT's collection policy is its own file, because a signed
policy for the receiving side does not exist in the API (§25, spec section 16)
— so the agent that has the WhatsApp channel has nothing to attest. And the
agent that does have a consent step, the `bills-agent`, runs at a terminal
where `in_person` is the correct attestation and `partner_session` would be a
worse claim, not a better one. **Open for v5.3:** which agent is the one whose
mandate is born in a conversation, and does `method: "verified_code"` (whose
contact must carry one of our own OTP verifications within 24 h) fit a kit
better than `partner_session` for that agent.

## 44. Measured: three runs from zero, no intervention

`npm run whatsapp:gate` — three runs of the `collections-agent` over the
channel, each from a clean state directory and a clean runs directory, the
debtor's turns from `channels/whatsapp/acordo-1042.json`, the model from the
recorded transcript, the rail the stub and the payer its fixture. The channel
talks to the emulator over HTTP, so every message is a real
`POST /v22.0/{phone-number-id}/messages` and every turn arrives as a signed
webhook our own receiver verifies. No external network, no key, no Meta
account. Measured 2026-09-24, on `--mode mandate`:

| Run | Final state | Records | In | Out |
|---|---|---|---|---|
| 1 | `settled` | 1 | 2 | 8 |
| 2 | `settled` | 1 | 2 | 8 |
| 3 | `settled` | 1 | 2 | 8 |

The gate names its conversation (`--conversation acordo-1042`), because the
agent ships two: `acordo-1042` ends paid and `acordo-1103` ends expired, and
which person a run messages is not a default.

What the gate asserts is the final state and the SHAPE of the conversation,
never the wording: settled, one receivable, one record, every message
delivered, the QR followed immediately by the copy-and-paste as its own
message, the person told the outcome, the contact masked in the log, and no
message carrying anything document-shaped. Then the three runs must agree with
each other and must not share a charge id — the part one run cannot show. The
clock is pinned to `2026-09-23T14:00:00-03:00` (#16) so the collection-hours
guardrail reads the same at 03:00 as at 15:00. `--mode human` passes too, with
`--approve`, because a script has no keyboard for an operator to answer from.

## 45. The interactive simulator has one keyboard and two people at it

`npm start -- --channel whatsapp` without `--scripted` reads the debtor's turns
from the terminal, and in `approval: human` the operator's question is read
from the same terminal. That is one person playing both parts, distinguishable
only by the prompt (`voce (+55 ****4321)>` against `[operador] Aprovar ...`).
It is honest for a demo and wrong for anything else; the operator's surface is
the dashboard, and this kit has none. The scripted path has no such problem,
which is why the gate uses it, and a scripted run in `human` mode without
`--approve` is refused outright rather than left waiting on a keyboard nobody
is at. **Open:** a second channel for the operator, or an explicit statement
that the interactive simulator is a demo and `--scripted` is the real path.

## 46. What the emulator did not do at 0.1.1, and what 0.2.0 closed

Driving the whole `collections-agent` flow through `dyvit-wa-sim` found five
gaps. They were first measured at `2f1f8bc120ddbc1bfa23386622f9a93f3fdeb980`,
the sha this lane pinned while the tool was not yet on npm, and re-measured
unchanged at `@dyvit/whatsapp-simulator-cli@0.1.1`. We reported them without
patching anything on our side or opening a pull request there, and
**`@dyvit/whatsapp-simulator-cli@0.2.0` closes all five.** The pin moved to it
on 2026-09-24.

Each gap below keeps the payload that failed, then what was measured against
0.2.0. The measuring is done by
`packages/agent-runtime/test/whatsapp-emulator.integration.test.ts`: its five
`GAP:` tests pinned the old behaviour, and they are now tests of the fixed one,
each written so it goes red if the gap reopens. A refusal is checked for what
it did NOT do (record the message, fire a webhook), not only for its status.
We checked that this works rather than assuming it: against 0.1.1 the file
fails 9 of its 14 cases, and against 0.2.0 all 14 pass. The release note was
treated as a claim to test. Where the binary differs from it, the difference is
listed at the end of this section.

**a. The 24-hour window was priced but not enforced. CLOSED.** On 0.1.1, after
`POST /_sim/clock {"advance_hours": 26}`, a free-form send

```http
POST /v22.0/{phone-number-id}/messages
{"messaging_product":"whatsapp","recipient_type":"individual","to":"5511987654321",
 "type":"text","text":{"preview_url":false,"body":"Recebemos, acordo quitado."}}
```

answered **`200 accepted`**. The real Cloud API answers `400` with error `131047`
and sends nothing. The pricing engine had already tagged the message
`INVALID_NON_TEMPLATE_OUTSIDE_CSW`.

Measured on 0.2.0: `400`, `error.code: 131047`, and an `error_data.details`
that names the instant the window closed. The message is absent from
`/_sim/state` and the webhook log does not grow. A template sent into the same
shut window still answers `200`, so this is the window rule and not a blanket
refusal. The note says a free-form message inside a Free Entry Point window
still passes. We did not measure that: no test opens an FEP window.

Enforcement changed three things on our side.

1. **Two of our own positive tests depended on the gap.** "Answers our text
   send with the Cloud API's own response shape" and the copy-and-paste send
   sent free-form text into a conversation the person had never opened. That
   passed only because of (a), and Meta would refuse it. Both tests now open
   the window with an inbound message first.
2. **The adapter reads 131047 as the rule it is.** `WhatsAppCloudApi.deliver`
   used to turn every non-2xx into `provider_refused` with the status and
   nothing else. It now reads Meta's error body (`providerRefusal` in
   `cloud-api.ts`) and maps 131047 to `session_window_closed`, the rule the
   channel already enforces before a send. Other codes stay `provider_refused`
   with the code named. After that refusal the channel's session window reads
   shut (`SessionWindow.observeProviderShut`) until the person writes again.
   The poll then sends the template under the once-only cursor it already holds.
   Without this, a 131047 on the free-form confirmation would have left the
   cursor taken and the person uninformed, and a second poll would have
   answered `already_told`, so the confirmation would have been lost.
3. **The gate now asks the provider, not only us.** The fourth run used to
   assert our own choice of carrier. Right after the clock moves it now also
   sends the free-form alternative straight to the emulator and requires
   `400/131047`. A **fifth run** drives the case (2) exists for. The
   conversation's clock moves 26 hours and the agent's moves one, so our window
   reads open and the provider's is shut, the same as a boundary race in
   production (our check at 23:59:59, Meta's at 24:00:01). The gate asserts
   exactly one refusal, the provider's 131047, followed by the template, told
   once, and exit 0. Measured on 2026-09-24: all five runs pass on 0.2.0. On
   0.1.1 the fourth and fifth fail ("the provider answered 200", "the
   confirmation went out as text"). With the poll fallback removed, the fifth
   fails on 0.2.0 ("the debtor was not told").

Our own check (`session_window_closed` before the backend is reached) stays.
It still keeps a message Meta would refuse from being sent in the first place.

**b. There was no way to redeliver or reorder a webhook. CLOSED.** On 0.1.1,
`POST /_sim/replay`, `POST /_sim/webhooks/replay` and `POST /_sim/redeliver` all
answered 404, and each status was dispatched exactly once, in order.

Measured on 0.2.0, with `POST /_sim/webhooks/{i}/redeliver` and
`POST /_sim/replay {"indexes":[...]}`:

- A redelivery carries a body identical to the original, same `wamid`
  included. That is a duplicate, the shape Meta's at-least-once delivery
  produces, not a second message. It also carries `replayOf: i`.
- `{"indexes":[b,a,a]}` delivers b, a, a in that order, repeats included.
- **Gotcha one:** the redelivery is itself a delivery, appended at the end of
  `GET /_sim/webhooks` under a new index. An index computed before a replay is
  still valid after it. The length of the list is not.
- **Gotcha two:** a missing index in the middle of a replay answers 404, and
  the entries BEFORE it were already redelivered. `[a, missing, a]` grew the
  list by exactly one. The call is not atomic, so a 404 does not mean nothing
  happened.
- The index space is global across conversations, not per conversation.

**It found a defect in our code, and the defect is fixed.** Our receiver
verified the redelivered signature, answered 200, and queued the same message a
second time. The agent would have answered one thing the person said twice.
`WhatsAppCloudApi` now drops a message id it has already handed on, still
answers 200 (Meta retries on anything else), and says so on the console. A unit
test covers it, and so does an integration test against the emulator's own
redelivery. Still not tested: out-of-order **status** webhooks against our
channel, because our receiver does not read statuses at all (see d).

**c. A `+` on one side and none on the other split one person into two
conversations. CLOSED.** 0.1.1 keyed a session on the literal
`${phone_number_id}:${to|from}`, and `POST /_sim/inbound` defaults `from` to
`+5511999999999`, which produced
`"keys": ["109876543210:+5511987654321", "109876543210:5511987654321"]`.

Measured on 0.2.0: an inbound `+5511987654321` and an outbound
`5511987654321` are one key, `{pnid}:5511987654321`, and a key requested with
the `+` finds the same conversation. The inbound webhook's `from` carries no
`+`, which is how Meta sends it.

`toGraphNumber` is **gone from the two places that existed only for this**:
the `from` of `EmulatorDriver.inbound` (`emulator.ts`) and the emulator session
key in `open.ts`, which only reads the priced timeline. It **stays in
`buildSendRequest`** (`cloud-api.ts`), where it builds the `to` of the real
Meta call. The reason there is Meta's documented number format, not the
emulator. Nothing in this repository has ever called Meta, so nothing here
shows that Meta accepts a `+`. Removing it on the strength of the emulator
would be a claim about Meta that we cannot back.

**d. Only `sent` and `delivered` were ever emitted. CLOSED.** Measured on 0.2.0
with `POST /_sim/status`:

- `{"status":"read","message_id":…}` emits a `read` status webhook for that
  message.
- `{"status":"failed","reason":"not on whatsapp","message_id":…}` emits
  `failed` with `errors[0].code: 131026` and `error_data.details` set to the
  reason.
- Two templates sent outside the window are both billed (total > 0). Failing
  one marks it `NOT_BILLABLE_FAILED`, and the total drops but stays above zero.

**Ours, and open:** our receiver ignores status webhooks entirely.
`parseInbound` reads messages, so the delivery state on an outbound line is
only ever what the send answered. The emulator can now show a read receipt or
a failure, and the channel does not listen. **Open:** whether a `failed`
(131026: not on WhatsApp, blocked) belongs in the record and on the operator's
console. It is a normal outcome on WhatsApp, and right now it would pass
unnoticed.

**e. An inbound interactive reply degraded to an empty text message. CLOSED.**
On 0.1.1, `POST /_sim/inbound` with `type: "interactive"` and a `button_reply`
produced `type: "text"`, `text.body: ""`.

Measured on 0.2.0: `button_reply`, `list_reply` and `nfm_reply` each go out as
`type: "interactive"` carrying Meta's object, with `id` preserved (and
`response_json` for `nfm_reply`). A reply without `id`, or an `nfm_reply`
without `response_json`, answers 400, and the webhook log does not grow.

**Ours, and open:** `parseInbound` reads text only. A tapped button is now
dropped with its id and type named on the console, which is honest, but the
debtor can tap "À vista" and the agent does not hear it. Turning a button reply
into a turn is a channel feature and is not in this change.

### Where 0.2.0 differs from its release note

Measured on 2026-09-24. None of these affects a test or the gate, because both
always name the conversation or the message.

- `POST /_sim/status` with neither `key` nor `message_id` marked the last
  message of the FIRST conversation the emulator held, not the most recent
  send overall. We read the note as saying the latter.
- It accepts `failed` after `read` for the same message, and accepts
  `delivered` as an injectable status. Meta does not move a read message to
  failed.
- `list_reply` loses the `description` that Meta's `list_reply` carries.
- The 404 of a partial replay counts the list after the redeliveries it
  already made: seven deliveries before the call, "there are 8 (0..7)" in the
  answer.

### And one gap that was ours, not the emulator's — now closed

The case in (a) — the agent speaking after the window shut — is the NORMAL
collections case: the debtor agrees on Tuesday and pays on Friday, and
"recebemos, acordo quitado" falls outside the window, where only an approved
template may go. Until issue #25 we could not run it end to end, and not
because of the emulator: there was no `codespar-agent poll --channel
whatsapp`. The terminal had `poll` for exactly this (the payer acts after the
conversation ended) and the channel did not, so the outcome message was always
sent inside the same turn that issued the charge, which is always inside the
window.

**CLOSED.** `poll` took a `--channel`, the agent took a template registry
(`channels/whatsapp/templates.json`), and the gate took a fourth run: agree,
`POST /_sim/clock {"advance_hours": 26}`, the sandbox payer pays, poll. What
the poll resumes from is the RECORD — the bundle's `channel.jsonl`, which now
carries the provider's timestamp on every inbound line, plus `state.db` — and
the confirmation is appended to that same conversation rather than opening a
second one.

Two things about it are worth keeping written down rather than implied.

**The fourth run asserted OUR choice of carrier, and now asserts the
provider's refusal too.** At 0.1.1 the emulator would have taken the free-form
message as well, so the session window in
`packages/agent-runtime/src/channels/whatsapp/session.ts` was the only thing
deciding. One correction to what this paragraph used to predict: the run did
not get stronger "without a line changing". The poll never tries the free-form
message once our window reads shut, so enforcement upstream never reached it.
It took the probe and the fifth run described in (a) above.

**Template APPROVAL is still a stub and still ours to leave that way.** The
registry proves the agent DECLARED the name, the language and the variable
count, so the three things Meta answers with a 4xx are refused locally instead.
Whether Meta approved the copy is a status in a Business account this
repository does not have. That is (a) of §42 and is unchanged.

**Open, and smaller:** an outcome with no declared template. The collections
agent declares three (paid, expired, cancelled) and returns nothing for a rail
failure or a denial, because nobody has written copy for telling a debtor
those, days later, in a template. The poll REPORTS such an outcome and exits
non-zero rather than sending an approximate one — the record says settled and
the person does not know — which is the right behaviour and not a solution.

## 47. What `npm run verify` proves, and the one thing it cannot (wave 5)

The API seals every agentic receipt with an Ed25519 signature over `codespar-receipt:v1:<receipt_id>:<chain>`, made with CodeSpar's platform issuer key (`did:web:id.codespar.dev`), and publishes the public keys with no credential at `/.well-known/codespar-receipt-keys.json`. `packages/agent-core/src/receipt-verification.ts` checks it with stock `node:crypto` and nothing else; `npm run verify -- <receipt-file>` is the command. That is the wave-5 gate: someone outside verifies a receipt without access to CodeSpar.

Three things are worth writing down rather than implying.

**What `verified` proves, exactly.** That CodeSpar sealed a receipt with THIS id and THIS chain. The chain is a SHA-256 over the RFC 8785 canonical JSON of the links of the Control Record, so the seller, the amount and the payee are inside it — the seller and the payee only when the spend presented a quote, which every kit spend does since §18 closed — but recomputing that digest from a receipt body needs the canonical link shapes, and CodeSpar publishes the signing string, not the link shapes. So a verifier can prove the receipt is CodeSpar's and cannot, by itself, prove that the body printed beside the chain is the body that was hashed into it. The verifier does not pretend otherwise. **Open:** publish the link shapes (or a `chain` recipe in the key document, beside `signing_string`), so a third party can close the loop from the body to the digest. Until then the honest reading is "CodeSpar attests to a settlement with this id and this digest".

It is also the reason the signature survives the proof bundle's masking: the bundle masks the payee, the signature covers the id and the digest, and the masked copy verifies exactly like the original. Convenient here, and the same fact both times.

**A receipt sealed before the capability existed carries no signature and never will.** There is no backfill, by design on the API side: signing a June receipt with today's key would attest to what the database says now, not to what happened then. `npm run verify` answers `unsigned` for those, with its own exit code, and says in as many words that this is not a failure. The five other verdicts — `verified`, `tampered`, `unknown_key`, `unreachable`, `malformed` — are kept apart for the same reason: a verifier that collapses "I could not reach the key set" into "invalid" calls every receipt fraudulent the day its DNS breaks.

**Every deployment now names itself in its `kid`, and receipts sealed before that still carry the old trap.** Measured 2026-09-24: production and staging both served `kid: "did:web:id.codespar.dev#1"` with different `x` values, so a sandbox receipt checked against the production key set found a key of that name, failed, and read `tampered`, which is a false accusation. ent#1641 fixed it on the API side. Measured again 2026-09-25: each document now carries `key_namespace` (`"production"`, `"staging"`), the active key is `did:web:id.codespar.dev#production-2` or `#staging-2`, and the old `#1` stays listed in both as `retired`, still with a different `x` in each. So a receipt sealed from now on names its deployment, and checked against the wrong one its `kid` is absent, which is `unknown_key` and honest. That part is read from the two documents; no receipt sealed under a namespaced key has been run through the verifier yet. A receipt sealed BEFORE the change keeps `#1` and keeps the trap: the pinned staging receipt `rcpt_BkYTo_9eJnlyzGsRjfFYHk` verifies against today's staging document (its key now reported as retired) and still reads `tampered` against production's. The `tampered` message that names the wrong-deployment reading stays for those. `npm run verify` does not read `key_namespace` in this change. Using it to report "this key set is from another deployment" instead of `tampered` for a legacy `#1` receipt is a separate item.

**The SDK's types caught up with the API. CLOSED.** `@codespar/sdk@0.16.6` was generated before `receipt_sig_ed25519` and `receipt_sig_kid` existed, so `packages/agent-core/src/api/rail.ts` read them off the response body outside the SDK's types. `@codespar/sdk@0.16.7` (codespar-core#184) types both as `string | null` on `GET /v1/consumers/receipts/{id}` (and on the receipt list and delivery routes). The pin moved to it, and the rail reads them through the generated type. Misspelling one is now a compile error, which was checked. A deployment older than ent#1633 omits both, and the rail still maps that, and an empty string, to null, which reads as `unsigned`. The published types also carry `key_namespace` as a required string on the `/.well-known/codespar-receipt-keys.json` document. The verifier's own `ReceiptKeyDocument` does not read it yet (see the paragraph above).
