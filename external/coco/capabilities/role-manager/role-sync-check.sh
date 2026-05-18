#!/usr/bin/env bash
# role-sync-check.sh — Sync assigned role from Dashboard DB
#
# Polls GET /internal/instances/:id/assigned-role and re-activates the role
# if it differs from the local .active-role. Run at VM startup and via timer.
#
# Required env vars (set by bootstrap.sh):
#   CONTROL_PLANE_URL   — Dashboard API base URL (e.g. https://api.coco.xyz/v1)
#   EMPLOYEE_ID         — This instance's ID
#   INTERNAL_API_SECRET — Shared secret for internal API authentication
#
# Optional env vars:
#   CAPABILITIES_DIR    — Default: ~/zylos/capabilities
#   ZYLOS_DIR           — Default: ~/zylos

set -euo pipefail

CAPABILITIES_DIR="${CAPABILITIES_DIR:-$HOME/zylos/capabilities}"
ACTIVE_ROLE_FILE="$CAPABILITIES_DIR/.active-role"
ROLE_MANAGER="${CAPABILITIES_DIR}/role-manager/role-manager.sh"

# ── Validate required env vars ───────────────────────────────────────────────

if [[ -z "${CONTROL_PLANE_URL:-}" || -z "${EMPLOYEE_ID:-}" || -z "${INTERNAL_API_SECRET:-}" ]]; then
  echo "[role-sync] Required env vars not set (CONTROL_PLANE_URL / EMPLOYEE_ID / INTERNAL_API_SECRET) — skipping"
  exit 0
fi

# ── Fetch assigned role from Dashboard ───────────────────────────────────────

api_response=$(curl -sf \
  --max-time 10 \
  -H "Authorization: Bearer ${INTERNAL_API_SECRET}" \
  "${CONTROL_PLANE_URL}/internal/instances/${EMPLOYEE_ID}/assigned-role" 2>/dev/null || echo "")

if [[ -z "$api_response" ]]; then
  echo "[role-sync] API call failed or timed out — skipping"
  exit 0
fi

db_role=$(echo "$api_response" | node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write((d.data && d.data.capabilityRole) || 'general-assistant');
  } catch { process.stdout.write('general-assistant'); }
" 2>/dev/null || echo "general-assistant")

# ── Compare with local active role ────────────────────────────────────────────

local_role=$(cat "$ACTIVE_ROLE_FILE" 2>/dev/null || echo "general-assistant")

if [[ "$db_role" == "$local_role" ]]; then
  echo "[role-sync] Role in sync: $local_role"
  exit 0
fi

# ── Activate the DB-assigned role ────────────────────────────────────────────

echo "[role-sync] Role drift detected: local=$local_role db=$db_role — activating $db_role"

if [[ ! -f "$ROLE_MANAGER" ]]; then
  echo "[role-sync] role-manager.sh not found at $ROLE_MANAGER — skipping"
  exit 1
fi

bash "$ROLE_MANAGER" activate "$db_role"
echo "[role-sync] Role sync complete: $db_role"
