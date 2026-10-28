# Runbook: the forty-second pull

What to say and do while the demo runs, against Iniciador's sweeping sandbox.

1. **Before** (no screen): the emulator is up (`npm run whatsapp:emulator` at the repository root) and a browser is open on any page. The link expires about a minute after it is created, so the browser has to be ready. In the shell that runs the agent, load the variables from their files; the values never go in a tracked file, a chat or a log:

   ```sh
   curl -s -X POST http://127.0.0.1:4290/_sim/reset -d '{}'      # a clean screen: the emulator forgets every conversation
   set -a; . ~/.config/codespar/iniciador-sandbox.env; set +a     # INICIADOR_CLIENT_ID, INICIADOR_CLIENT_SECRET, INICIADOR_TEST_TAX_ID
   set -a; . <file holding ANTHROPIC_API_KEY>; set +a             # the model; check it with: test -n "$ANTHROPIC_API_KEY"
   export INICIADOR_CREDITOR_ID=... INICIADOR_TRIGGER_ID=... INICIADOR_PARTICIPANT_ID=...   # README.md, "The sandbox demo"
   ```

   Without `ANTHROPIC_API_KEY` the runner falls back to the replay provider: the agent's lines are the recorded ones, whatever the person types. The pull itself still goes through the mandate and the bank, but the conversation is not the model reading the person.
2. **0 s.** `npm start -- --channel whatsapp --conversation recarga --rail api --mode mandate --wait 300`. "This is the person's own agent. It can put money in their account, and nothing else."
3. **5 s.** Type `oi, quero colocar R$ 1 na minha conta`. The agent reads the account and asks for a yes. "Nothing has been asked of the bank yet."
4. **10 s.** Type `sim`. The console shows the execution approved under the mandate and `executing`; the conversation gets the amount and the bank's link. "The bank was asked for an authorization limited to R$ 5,00 per pull and R$ 10,00 in total, the same two numbers the mandate holds."
5. **15 s.** Open the link. Mocktora: any user and password, pick the account, Autorizar. "The person approves at their bank. The agent cannot do this step."
6. **~40 s.** The console shows `settled`; the conversation gets the end-to-end id. "One pull, made once, after the bank said yes. The end-to-end id is the Pix's own reference; nothing here seals a receipt for it."

If the link expires (step 5 took too long): the conversation says so and offers another. Type `sim` again; a new execution, a new link.

If the run stops looking before the pull completes: `npm run poll -- --channel whatsapp --conversation recarga`.

# Runbook: the biometric pull (JSR) on a phone

The same top-up with Iniciador's JSR instead of sweeping: the person registers a passkey once, on Iniciador's hosted page, and signs each pull with the phone's biometrics. No mandate at the bank; the local mandate still caps the amount and pins the account. The conversation runs on the phone over the local network, with the simulator from a checkout of [`whatsapp-simulator`](https://github.com/fabianocruz/whatsapp-simulator) (its `cta_url` rendering fix is not in the pinned 0.3.0).

1. **Network.** The computer and the phone on the same Wi-Fi; the computer's address from `hostname -I | awk '{print $1}'`. A firewall lets 3000 and 4290 in from the local network only.
2. **Emulator** (in the checkout): `cd packages/cli && npx tsx src/cli.ts serve --host 0.0.0.0 --port 4290 --webhook http://127.0.0.1:4399/ --app-secret dev`. Before each take: `curl -s -X POST http://127.0.0.1:4290/_sim/reset -d '{}'`.
3. **Simulator page** (in the checkout): `cd apps/web && npx next dev -H 0.0.0.0`. On the phone: `http://<address>:3000`, live mode on, emulator URL `http://<address>:4290`.
4. **The agent's shell.** Values from their files, never typed into a tracked file, a chat or a log:

   ```sh
   set -a; . ~/.config/codespar/iniciador-sandbox.env; set +a     # INICIADOR_CLIENT_ID, INICIADOR_CLIENT_SECRET, INICIADOR_TEST_TAX_ID
   set -a; . <file holding ANTHROPIC_API_KEY>; set +a             # without it the agent replays and does not read the phone
   export INICIADOR_RAIL=jsr INICIADOR_JSR_ENROLL=always         # always: a new passkey, on this phone, for this take
   export INICIADOR_PARTICIPANT_ID=...                           # the test bank, as for sweeping
   export INICIADOR_CREDITOR_NAME=... INICIADOR_CREDITOR_ISPB=... INICIADOR_CREDITOR_ISSUER=... INICIADOR_CREDITOR_NUMBER=... INICIADOR_CREDITOR_ACCOUNT_TYPE=...
   export TOPUP_STATE_DIR=$HOME/.cache/codespar/topup-jsr-$(date +%H%M) TOPUP_RUNS_DIR=$TOPUP_STATE_DIR/runs   # a clean state per take
   ```

   The creditor is the person's own account; its tax id is `INICIADOR_TEST_TAX_ID` unless `INICIADOR_CREDITOR_TAX_ID` says otherwise.
5. **0 s.** `npm start -- --channel whatsapp --conversation recarga --rail api --mode mandate --wait 900` (900 s covers the enrollment window and the signing window).
6. On the phone: `oi, quero colocar R$ 1 na minha conta`; the agent asks for a yes. `sim`.
7. **Cadastrar biometria.** Tap it within about a minute (the link expires). The test bank takes any login; approve; then Iniciador's page, "Autorizar com biometria", fingerprint or face on the phone.
8. **Confirmar biometria.** Arrives by itself a few seconds later. Tap it and sign with the biometrics (about 10 minutes before the bank rejects it).
9. The conversation gets the Pix end-to-end id; the console shows `settled` and the record's path.

If the enrollment link expires, or the payment is not signed in time, the agent says so and offers another: `sim` again is a new execution and new links. The links carry credentials (a `request_uri`, a JWT): the person gets them whole, `channel.jsonl` keeps only their address.
