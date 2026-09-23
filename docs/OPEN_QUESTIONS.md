# Open questions and divergences from spec v5.1.1

Kept as the prompt asks: when the spec and the real API diverge, the code follows the API and the divergence is written here. Each entry names what the spec says, what reality showed, what the code does, and who decides. Input for v5.2.

## 1. `cli:` pin — the spec says `@codespar/cli@0.6.0`, npm publishes 0.12.1

`agent.yaml` pins `cli: "@codespar/cli@0.12.1"` (verified on npm on 2026-09-23; 0.6.0 is stale). The manifest schema accepts any exact version; the check only refuses an unpinned one. The `mcp` pin `@codespar/mcp@0.5.8` matches. Decision taken 2026-09-23. **v5.2:** update section 14.4 and the example in 4.3.

## 2. `actor` has no field on the wire

Section 4.5 says every API call carries `actor`. `POST /v1/consumers/mandates/{id}/spend` and `POST /v1/consumer-payments/execute` carry `agent_id` and nothing else about who acts; the receipt (`GET /v1/consumers/receipts/{id}`) carries no actor either. What the code does: the spend sends `agent_id` (which the mandate binds, so attribution is the mandate's, not the caller's); the full `actor` object (`agent` + `on_behalf_of`, or `human` + `channel`) is stamped on every event of `events.jsonl`, on every approval artifact and on the local copy of every receipt. The CI checks the local copies. **Open:** does the API want an `actor` (or `on_behalf_of`) field on spend, and should the receipt carry it? Until then "actor on everything" is true locally and not on the wire.

## 3. Who signs the approval artifact — STUB

The API does not sign approval lists; its HMAC is the mandate proof and the receipt seal. The artifact of section 4.2 is signed with a local development key at `.codespar/approval.key` (generated on first use, mode 0600, gitignored), marked as a stub in `packages/agent-core/src/approval.ts` and in the READMEs. It proves what was approved to whoever runs the agent, and to nobody else. No third env var was added. **Open:** an API-side signature (or Ed25519 with the agent key from KYA) so the artifact means something to a third party.

## 4. Revocation and kill switch — STUB

`codespar mandates revoke` and `org pauseAll` are AgentGate preview. The `MandateStatusSource` interface is in the core; the shipped implementation is `packages/agent-core/src/stubs/agentgate.ts` over the local state.db, which the `mandate-revoked` scenario drives. With a test key, `ApiMandateStatusSource` reads `GET /v1/mandates/{id}` for the mandate status (`active | paused | revoked | expired`, and expiry from `expires_at`); the organization pause has no API surface, so `org_paused` still comes from the stub. **Open:** an org-level pause read, and a way for a revocation to reach a running agent (a trigger event) instead of a poll before `executing`.

## 5. Spend by id, not by signed envelope

The brief expected `POST /v1/consumer-payments/execute` with `{ mandate, signature }`. The consent flow returns `{ mandate, signature }` to the **callback_url** or to the consumer's browser at submit; a terminal kit with no server never receives them. `POST /v1/consumers/mandates/{id}/spend` (same lifecycle, same gates, "the path `codespar_pay` takes internally") needs only the id, which `GET /v1/mandates` lists. The kit spends by id. **v5.2:** name the by-id route as the kit's path; keep the signed-envelope route for callers that hold the envelope.

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

## 12. First receipt — blocked on a test key

The one-time real run (clone → `.env` → `npm install && npm start` → "pague a escola de outubro" → approve) needs a `csk_test_` key for a project whose consumer can sign a hosted consent in the sandbox. The key at `~/.codespar/demo-keys/payer.key` on the build machine is an x402 EOA, not a CodeSpar key, so the run was not made and the timing was not recorded. The path is implemented (`embedded-consent` module: `POST /v1/consents/init`, poll `GET /v1/mandates`, `POST /v1/test/fund`, spend by id, `GET /v1/consumers/receipts/{id}`) and typed against the SDK 0.16.2 OpenAPI snapshot, but it has not been exercised against the sandbox. See the PR for the status.

## 13. Things reality showed the spec got wrong (summary for v5.2)

- CLI version (1). `actor` on the wire (2). Who signs the approval list (3). Spend by id (5). `new_beneficiary` and the first month (6). Fractioning counts only autonomous runs (7). `approval.json` is a list (9). `outside_hours` is a closed window in a named timezone (11).
