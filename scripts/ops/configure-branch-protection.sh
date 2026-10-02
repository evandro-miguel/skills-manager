#!/usr/bin/env sh
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
REMOTE_URL=$(git -C "$REPO_DIR" config --get remote.origin.url || true)
REQUIRED_CHECK="${REQUIRED_CHECK:-quality-gates}"
BRANCH="${BRANCH:-main}"

if [ "${1:-}" = "--help" ]; then
  cat <<EOF
Configure GitHub branch protection for universall-skill-sys

Requirements:
  - GH_TOKEN or GITHUB_TOKEN with repo admin permissions
  - remote.origin.url set to GitHub repository

Environment overrides:
  BRANCH          Branch name (default: main)
  REQUIRED_CHECK  Required status check (default: quality-gates)

Example:
  GH_TOKEN=*** $0
EOF
  exit 0
fi

if [ -z "$REMOTE_URL" ]; then
  echo "ERROR: remote.origin.url not found" >&2
  exit 1
fi

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "ERROR: set GH_TOKEN or GITHUB_TOKEN with admin rights for the repo" >&2
  exit 1
fi

case "$REMOTE_URL" in
  git@github.com:*)
    REPO_PATH=$(printf "%s" "$REMOTE_URL" | sed -E 's#git@github.com:##; s#\.git$##')
    ;;
  https://github.com/*)
    REPO_PATH=$(printf "%s" "$REMOTE_URL" | sed -E 's#https://github.com/##; s#\.git$##')
    ;;
  *)
    echo "ERROR: unsupported remote URL format: $REMOTE_URL" >&2
    exit 1
    ;;
esac

OWNER=$(printf "%s" "$REPO_PATH" | cut -d/ -f1)
REPO=$(printf "%s" "$REPO_PATH" | cut -d/ -f2)

PAYLOAD=$(cat <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["$REQUIRED_CHECK"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
)

curl -fsS -X PUT \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/branches/$BRANCH/protection" \
  -d "$PAYLOAD" >/dev/null

echo "Branch protection configured: $OWNER/$REPO ($BRANCH)"
echo "Required status check: $REQUIRED_CHECK"
