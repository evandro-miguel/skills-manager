#!/usr/bin/env sh
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CODEX_SKILLS_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun is required but was not found in PATH" >&2
  exit 1
fi

git -C "$REPO_DIR" pull --ff-only

if [ "${VERIFY_SIGNED_TAG:-0}" = "1" ]; then
  if [ -z "${RELEASE_REF:-}" ]; then
    echo "ERROR: set RELEASE_REF when VERIFY_SIGNED_TAG=1" >&2
    exit 1
  fi
  git -C "$REPO_DIR" tag -v "$RELEASE_REF"
fi

if [ -n "${EXPECTED_SOURCE_SHA256:-}" ]; then
  ACTUAL_SHA=$(bun "$REPO_DIR/scripts/commands/source-checksum.ts" --source "$REPO_DIR")
  if [ "$ACTUAL_SHA" != "$EXPECTED_SOURCE_SHA256" ]; then
    echo "ERROR: source checksum mismatch expected=$EXPECTED_SOURCE_SHA256 actual=$ACTUAL_SHA" >&2
    exit 1
  fi
fi

bun "$REPO_DIR/scripts/commands/universal-contract.ts" --skills-root "$REPO_DIR/skills"
CODEX_SKILLS_DIR="$CODEX_SKILLS_DIR" bun "$REPO_DIR/scripts/commands/sync-global-core.ts" --source "$REPO_DIR" --apps codex --no-contract-check

echo "Done: synced global core to $CODEX_SKILLS_DIR"
