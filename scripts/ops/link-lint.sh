#!/usr/bin/env bash
set -euo pipefail

ROOTS=("${@:-skills}")
if [[ $# -eq 0 ]]; then
  ROOTS=(skills)
fi

if command -v lychee >/dev/null 2>&1; then
  echo "Using lychee (external + local links)..."
  # shellcheck disable=SC2046
  lychee --no-progress --exclude-mail $(find "${ROOTS[@]}" -type f -name '*.md' | tr '\n' ' ')
else
  echo "lychee not found; using internal markdown link guard..."
  bun scripts/commands/markdown-link-guard.ts --no-wikilinks "${ROOTS[@]}"
fi
