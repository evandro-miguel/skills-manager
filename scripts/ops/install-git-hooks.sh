#!/usr/bin/env sh
set -eu

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not inside a git repository, skipping hook installation."
  exit 0
fi

repo_root=$(git rev-parse --show-toplevel)
if [ ! -d "$repo_root/.githooks" ]; then
  echo "No repository hooks supplied, skipping hook installation."
  exit 0
fi

git config --local core.hooksPath .githooks
echo "Configured git hooks path to .githooks"
