#!/usr/bin/env bash
# inject-role.sh — Called at session start to output the active role's system prompt
# This script is invoked by the Zylos session-start hook.
# If an active role is configured, it echoes the role's system prompt
# so it can be included in the session context.
#
# Exit codes:
#   0 — success (role prompt printed or no role configured)
#   1 — error reading role files

CAPABILITIES_DIR="${CAPABILITIES_DIR:-$HOME/zylos/capabilities}"
ZYLOS_MEMORY_DIR="${ZYLOS_MEMORY_DIR:-$HOME/zylos/memory}"
ACTIVE_ROLE_FILE="$CAPABILITIES_DIR/.active-role"
ROLE_PROMPT_FILE="$ZYLOS_MEMORY_DIR/active-role.md"

# If no active role file, nothing to inject
[ -f "$ACTIVE_ROLE_FILE" ] || exit 0

# If the compiled prompt file exists, output it
if [ -f "$ROLE_PROMPT_FILE" ]; then
  cat "$ROLE_PROMPT_FILE"
  exit 0
fi

# Fallback: regenerate from bundle
ROLE_ID=$(cat "$ACTIVE_ROLE_FILE" 2>/dev/null || echo "general-assistant")
BUNDLE_PROMPT="$CAPABILITIES_DIR/$ROLE_ID/system-prompt.md"

if [ -f "$BUNDLE_PROMPT" ]; then
  mkdir -p "$ZYLOS_MEMORY_DIR"
  {
    echo "---"
    echo "# Active Role: $ROLE_ID"
    echo "---"
    echo ""
    cat "$BUNDLE_PROMPT"
  } | tee "$ROLE_PROMPT_FILE"
fi
