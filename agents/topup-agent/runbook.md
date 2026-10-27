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
