#!/usr/bin/env bash
# Runs once, when the container is created (devcontainer.json postCreateCommand).
# Installs the workspace at the repository ROOT and wires the secret-scan hook,
# the same two things a local clone gets from `npm install` (prepare).
set -euo pipefail

cd "$(dirname "$0")/.."

# A workspace mounted from the host (devcontainer CLI, the CI action) is owned by
# another uid than the container user; git refuses to touch it until told it is safe.
# A Codespace clones as the container user, so this is a no-op there.
git config --global --add safe.directory "$(pwd)"

node --version
npm --version
npm install
git config core.hooksPath .githooks
echo "secret-scan hook: $(git config core.hooksPath)"
