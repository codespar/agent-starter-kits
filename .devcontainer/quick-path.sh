#!/usr/bin/env bash
# Printed every time a terminal attaches (devcontainer.json postAttachCommand).
# Keys come from Codespaces secrets (environment variables), never from a committed file.
cd "$(dirname "$0")/.." 2>/dev/null || true

key="${CODESPAR_API_KEY:-}"
if [ -z "$key" ] || [ "$key" = "csk_test_your_key_here" ]; then
  key_line="CODESPAR_API_KEY   not set: the run uses the local stub rail (no receipt from the API)"
elif [ "${key#csk_test_}" = "$key" ]; then
  key_line="CODESPAR_API_KEY   set, but not a csk_test_ key: the kit refuses it before any network call"
else
  key_line="CODESPAR_API_KEY   set (csk_test_...)"
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "sk-ant-your_key_here" ]; then
  model_line="ANTHROPIC_API_KEY  set: the model runs for real"
else
  model_line="ANTHROPIC_API_KEY  not set: the recorded happy path replays"
fi

cat <<MSG

CodeSpar Agent Starter Kits, in a container ($(node --version))

  $key_line
  $model_line
  CODESPAR_API_URL   ${CODESPAR_API_URL:-unset (production; staging keys need https://api.staging.codespar.dev)}

  Keys: Settings > Codespaces > Secrets on GitHub, then reload this window.
  No .env file is needed here; a secret already in the environment wins over one.

  npm run consent -- --yes      # signs the sandbox mandate once (needs the test key)
  npm start                     # or: npm start -- --input "pague a escola de outubro" --approve
  npm run check && npm test     # the gates, no key needed

MSG
