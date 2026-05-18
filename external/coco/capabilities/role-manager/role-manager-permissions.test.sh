#!/usr/bin/env bash
#
# Tests for apply_tool_permissions and clear_tool_permissions in role-manager.sh
#
# Tests the full activate/reset flow end-to-end to verify tools.json →
# settings.json permissions.deny mapping is correct for all flag combinations.
#
# Run: bash infra/golden-image/capabilities/role-manager/role-manager-permissions.test.sh
#
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLE_MANAGER="$SCRIPT_DIR/role-manager.sh"

# ── Helpers ───────────────────────────────────────────────────────────────────

assert_eq() {
  local test_name="$1" expected="$2" actual="$3"
  if [[ "${expected}" == "${actual}" ]]; then
    echo "  PASS: ${test_name}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ${test_name}"
    echo "    expected: ${expected}"
    echo "    actual:   ${actual}"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: ${test_name}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ${test_name}"
    echo "    expected to contain: ${needle}"
    echo "    actual: ${haystack}"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local test_name="$1" needle="$2" haystack="$3"
  if ! echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: ${test_name}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: ${test_name}"
    echo "    expected NOT to contain: ${needle}"
    echo "    actual: ${haystack}"
    FAIL=$((FAIL + 1))
  fi
}

# Set up a minimal temp capabilities environment, run role-manager activate,
# and return the resulting deny list from settings.json.
#
# Args:
#   $1 — tools.json content (tool_permissions object)
#   $2 — role ID to create (default: test-role)
#
run_activate() {
  local tools_json="$1"
  local role_id="${2:-test-role}"

  local tmpdir
  tmpdir=$(mktemp -d)

  local cap_dir="$tmpdir/capabilities"
  local bundle_dir="$cap_dir/$role_id"
  local zylos_dir="$tmpdir/zylos"
  local settings_file="$zylos_dir/.claude/settings.json"
  local memory_dir="$zylos_dir/memory"

  mkdir -p "$bundle_dir" "$zylos_dir/.claude" "$memory_dir"

  # Minimal registry.json with our test role
  cat > "$cap_dir/registry.json" <<JSON
{
  "roles": [
    {
      "id": "$role_id",
      "name": "Test Role",
      "name_zh": "测试角色",
      "icon": "🧪",
      "type": "test",
      "tagline_zh": "test",
      "suitable_for_zh": "test"
    }
  ]
}
JSON

  # Minimal system-prompt.md
  echo "# Test Role" > "$bundle_dir/system-prompt.md"

  # tools.json with the permissions under test
  echo "$tools_json" > "$bundle_dir/tools.json"

  # Initial settings.json (empty deny list)
  echo '{"permissions":{"deny":[]}}' > "$settings_file"

  CAPABILITIES_DIR="$cap_dir" \
  ZYLOS_DIR="$zylos_dir" \
  ZYLOS_MEMORY_DIR="$memory_dir" \
    bash "$ROLE_MANAGER" activate "$role_id" > /dev/null 2>&1

  # Output the deny list
  node -e "
    const s = JSON.parse(require('fs').readFileSync('$settings_file','utf8'));
    process.stdout.write(JSON.stringify(s.permissions?.deny ?? []));
  " 2>/dev/null || echo "[]"

  rm -rf "$tmpdir"
}

# Set up a temp env with a deny list already set, run reset, return deny list.
run_reset() {
  local initial_deny_json="$1"

  local tmpdir
  tmpdir=$(mktemp -d)

  local cap_dir="$tmpdir/capabilities"
  local ga_bundle="$cap_dir/general-assistant"
  local zylos_dir="$tmpdir/zylos"
  local settings_file="$zylos_dir/.claude/settings.json"
  local memory_dir="$zylos_dir/memory"

  mkdir -p "$ga_bundle" "$zylos_dir/.claude" "$memory_dir"

  cat > "$cap_dir/registry.json" <<'JSON'
{"roles":[{"id":"general-assistant","name":"General Assistant","name_zh":"通用助手","icon":"🤖","type":"assistant","tagline_zh":"test","suitable_for_zh":"test"}]}
JSON

  echo "# General Assistant" > "$ga_bundle/system-prompt.md"
  echo '{"tool_permissions":{}}' > "$ga_bundle/tools.json"
  echo "general-assistant" > "$cap_dir/.active-role"

  # Start with a non-empty deny list
  echo "{\"permissions\":{\"deny\":$initial_deny_json}}" > "$settings_file"

  CAPABILITIES_DIR="$cap_dir" \
  ZYLOS_DIR="$zylos_dir" \
  ZYLOS_MEMORY_DIR="$memory_dir" \
    bash "$ROLE_MANAGER" reset > /dev/null 2>&1

  node -e "
    const s = JSON.parse(require('fs').readFileSync('$settings_file','utf8'));
    process.stdout.write(JSON.stringify(s.permissions?.deny ?? []));
  " 2>/dev/null || echo "[]"

  rm -rf "$tmpdir"
}

# ── Tests: apply_tool_permissions (via activate) ──────────────────────────────

echo "=== apply_tool_permissions tests (via role-manager activate) ==="
echo ""

echo "-- bash_execution: false → deny includes Bash --"
deny=$(run_activate '{"tool_permissions":{"bash_execution":false}}')
assert_contains "bash_execution:false adds Bash" '"Bash"' "$deny"
assert_not_contains "bash_execution:false no Read" '"Read"' "$deny"
assert_not_contains "bash_execution:false no WebSearch" '"WebSearch"' "$deny"
echo ""

echo "-- file_read: false → deny includes Read and Glob --"
deny=$(run_activate '{"tool_permissions":{"file_read":false}}')
assert_contains "file_read:false adds Read" '"Read"' "$deny"
assert_contains "file_read:false adds Glob" '"Glob"' "$deny"
assert_not_contains "file_read:false no Bash" '"Bash"' "$deny"
echo ""

echo "-- file_write: false → deny includes Write and Edit --"
deny=$(run_activate '{"tool_permissions":{"file_write":false}}')
assert_contains "file_write:false adds Write" '"Write"' "$deny"
assert_contains "file_write:false adds Edit" '"Edit"' "$deny"
assert_not_contains "file_write:false no Bash" '"Bash"' "$deny"
echo ""

echo "-- web_search: false → deny includes WebSearch, NOT WebFetch --"
deny=$(run_activate '{"tool_permissions":{"web_search":false}}')
assert_contains "web_search:false adds WebSearch" '"WebSearch"' "$deny"
assert_not_contains "web_search:false no WebFetch" '"WebFetch"' "$deny"
echo ""

echo "-- network_access: false → deny includes WebFetch AND WebSearch --"
deny=$(run_activate '{"tool_permissions":{"network_access":false}}')
assert_contains "network_access:false adds WebFetch" '"WebFetch"' "$deny"
assert_contains "network_access:false adds WebSearch" '"WebSearch"' "$deny"
echo ""

echo "-- network_access:false superset: web_search:true is ignored --"
deny=$(run_activate '{"tool_permissions":{"network_access":false,"web_search":true}}')
assert_contains "superset: WebFetch still denied" '"WebFetch"' "$deny"
assert_contains "superset: WebSearch still denied" '"WebSearch"' "$deny"
echo ""

echo "-- all permissions true → deny is empty array --"
deny=$(run_activate '{"tool_permissions":{"bash_execution":true,"file_read":true,"file_write":true,"web_search":true,"network_access":true}}')
assert_eq "all true → deny []" "[]" "$deny"
echo ""

echo "-- multiple restrictions combined --"
deny=$(run_activate '{"tool_permissions":{"bash_execution":false,"file_write":false,"network_access":false}}')
assert_contains "combined: Bash" '"Bash"' "$deny"
assert_contains "combined: Write" '"Write"' "$deny"
assert_contains "combined: Edit" '"Edit"' "$deny"
assert_contains "combined: WebFetch" '"WebFetch"' "$deny"
assert_contains "combined: WebSearch" '"WebSearch"' "$deny"
assert_not_contains "combined: no Read" '"Read"' "$deny"
echo ""

echo "-- no tools.json → deny stays empty (no crash) --"
tmpdir=$(mktemp -d)
cap_dir="$tmpdir/capabilities"
bundle_dir="$cap_dir/no-tools-role"
zylos_dir="$tmpdir/zylos"
memory_dir="$zylos_dir/memory"
settings_file="$zylos_dir/.claude/settings.json"
mkdir -p "$bundle_dir" "$zylos_dir/.claude" "$memory_dir"
echo '{"tool_permissions":{}}' > "$bundle_dir/tools.json"
rm "$bundle_dir/tools.json"  # remove it — no tools.json
echo "# No Tools Role" > "$bundle_dir/system-prompt.md"
cat > "$cap_dir/registry.json" <<'JSON'
{"roles":[{"id":"no-tools-role","name":"No Tools","name_zh":"无工具","icon":"🔇","type":"test","tagline_zh":"t","suitable_for_zh":"t"}]}
JSON
echo '{"permissions":{"deny":[]}}' > "$settings_file"
exit_code=0
CAPABILITIES_DIR="$cap_dir" ZYLOS_DIR="$zylos_dir" ZYLOS_MEMORY_DIR="$memory_dir" \
  bash "$ROLE_MANAGER" activate no-tools-role > /dev/null 2>&1 || exit_code=$?
assert_eq "no tools.json → activate exits cleanly" "0" "$exit_code"
deny=$(node -e "const s=JSON.parse(require('fs').readFileSync('$settings_file','utf8')); process.stdout.write(JSON.stringify(s.permissions?.deny??[]));" 2>/dev/null)
assert_eq "no tools.json → deny unchanged (empty)" "[]" "$deny"
rm -rf "$tmpdir"
echo ""

# ── Tests: clear_tool_permissions (via reset) ─────────────────────────────────

echo "=== clear_tool_permissions tests (via role-manager reset) ==="
echo ""

echo "-- reset clears existing deny list --"
deny=$(run_reset '["Bash","WebSearch","Read"]')
assert_eq "reset clears deny to []" "[]" "$deny"
echo ""

echo "-- reset on already-empty deny list is a no-op --"
deny=$(run_reset '[]')
assert_eq "reset on empty deny stays []" "[]" "$deny"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────

echo "========================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "========================================"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
