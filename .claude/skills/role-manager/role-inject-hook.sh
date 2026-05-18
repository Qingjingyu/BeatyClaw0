#!/usr/bin/env bash
# role-inject-hook.sh — SessionStart hook for role system prompt injection
# Called by Claude Code's SessionStart hook system.
# Outputs the active role's system prompt and foundational capabilities to be injected as a system-reminder.

ZYLOS_MEMORY_DIR="${ZYLOS_DIR:-$HOME/zylos}/memory"
ACTIVE_ROLE_FILE="${ZYLOS_DIR:-$HOME/zylos}/capabilities/.active-role"
ROLE_PROMPT_FILE="$ZYLOS_MEMORY_DIR/active-role.md"
FOUNDATION_FILE="$ZYLOS_MEMORY_DIR/foundation.md"

# Inject foundational capabilities (available to all roles)
if [ -f "$FOUNDATION_FILE" ]; then
  echo "=== FOUNDATIONAL CAPABILITIES ==="
  cat "$FOUNDATION_FILE"
  echo ""
fi

# No active role configured: nothing more to inject
[ -f "$ACTIVE_ROLE_FILE" ] || exit 0

ROLE_ID=$(cat "$ACTIVE_ROLE_FILE" 2>/dev/null)
[ -n "$ROLE_ID" ] || exit 0

# Output the role prompt file if it exists
if [ -f "$ROLE_PROMPT_FILE" ]; then
  echo "=== ACTIVE AGENT ROLE ==="
  cat "$ROLE_PROMPT_FILE"
  echo ""
fi
