#!/usr/bin/env sh
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SCHEDULE="${SCHEDULE:-0 * * * *}"
LOG_FILE="${LOG_FILE:-$REPO_DIR/logs/skillpool/doctor-all.log}"
OPENCODE_SKILLS="${OPENCODE_SKILLS:-$HOME/.config/opencode/skills}"
CODEX_SKILLS="${CODEX_SKILLS:-$HOME/.codex/skills}"
CLAUDE_SKILLS="${CLAUDE_SKILLS:-$HOME/.claude/skills}"
QWEN_SKILLS="${QWEN_SKILLS:-$HOME/.qwen/skills}"
GEMINI_SKILLS="${GEMINI_SKILLS:-$HOME/.gemini/skills}"
DOCTOR_REPAIR="${DOCTOR_REPAIR:-0}"
ALLOW_GLOBAL_CRON="${ALLOW_GLOBAL_CRON:-0}"
MARKER="# skillpool-doctor-all"

if [ "${1:-}" = "--help" ]; then
  cat <<EOF
Install cron entry for universal-skills doctor-all.

This is host-global maintenance and is disabled by default. Prefer running
doctor commands manually from the repository folder. Set ALLOW_GLOBAL_CRON=1
only when you intentionally want a recurring host-level job.

Environment overrides:
  SCHEDULE         Cron expression (default: 0 * * * *)
  LOG_FILE         Log destination (default: logs/skillpool/doctor-all.log)
  OPENCODE_SKILLS  OpenCode skills path
  CODEX_SKILLS     Codex skills path
  CLAUDE_SKILLS    Claude Code skills path
  QWEN_SKILLS      Qwen skills path
  GEMINI_SKILLS    Gemini CLI skills path
  DOCTOR_REPAIR    Set to 1 to enable --repair in scheduled runs
  ALLOW_GLOBAL_CRON Set to 1 to permit cron installation

Example:
  ALLOW_GLOBAL_CRON=1 SCHEDULE="*/30 * * * *" $0
EOF
  exit 0
fi

if [ "$ALLOW_GLOBAL_CRON" != "1" ]; then
  cat >&2 <<EOF
ERROR: install-doctor-cron.sh is disabled by default.

Recurring doctor jobs are host-global maintenance and can escape project
sandboxes. Run doctor manually from the repository folder, or set
ALLOW_GLOBAL_CRON=1 only for an explicit host-level maintenance window.
EOF
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun not found in PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")"

BUN_BIN=$(command -v bun)
REPAIR_FLAG=""
if [ "$DOCTOR_REPAIR" = "1" ]; then
  REPAIR_FLAG="--repair"
fi

COMMAND="cd \"$REPO_DIR\" && \"$BUN_BIN\" scripts/commands/doctor-all.ts --source \"$REPO_DIR\" --opencode-skills \"$OPENCODE_SKILLS\" --codex-skills \"$CODEX_SKILLS\" --claude-skills \"$CLAUDE_SKILLS\" --qwen-skills \"$QWEN_SKILLS\" --gemini-skills \"$GEMINI_SKILLS\" $REPAIR_FLAG >> \"$LOG_FILE\" 2>&1"
ENTRY="$SCHEDULE $COMMAND $MARKER"

TMP_FILE=$(mktemp)
crontab -l 2>/dev/null | sed "/$MARKER/d" > "$TMP_FILE" || true
printf "%s\n" "$ENTRY" >> "$TMP_FILE"
crontab "$TMP_FILE"
rm -f "$TMP_FILE"

echo "Installed cron entry:"
echo "$ENTRY"
