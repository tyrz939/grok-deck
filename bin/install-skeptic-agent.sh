#!/usr/bin/env bash
# Copy the shipped skeptic agent into ~/.grok/agents so `grok --agent skeptic` can find it.
# The service itself passes the repo file path and does not depend on this copy.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "${HOME}/.grok/agents"
cp "${root}/agents/skeptic.md" "${HOME}/.grok/agents/skeptic.md"
chmod 644 "${HOME}/.grok/agents/skeptic.md"
echo "installed ${HOME}/.grok/agents/skeptic.md"
