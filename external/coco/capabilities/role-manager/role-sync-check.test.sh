#!/usr/bin/env bash
#
# Tests for role-sync-check.sh
#
# Validates role drift detection, env var handling, API response parsing,
# and role-manager invocation logic.
#
# Run: bash infra/golden-image/capabilities/role-manager/role-sync-check.test.sh
#
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/role-sync-check.sh"

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

assert_exit_code() {
  local test_name="$1" expected_code="$2"
  shift 2
  local actual_code=0
  "$@" || actual_code=$?
  assert_eq "$test_name" "$expected_code" "$actual_code"
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

# Run role-sync-check.sh in an isolated env.
# Params: env vars as KEY=VALUE pairs, curl_response (empty = simulate curl fail)
run_sync() {
  local tmpdir="$1"; shift
  local curl_response="$1"; shift
  # remaining args: extra env vars

  local capabilities_dir="$tmpdir/capabilities"
  local active_role_file="$capabilities_dir/.active-role"
  local stub_role_manager="$capabilities_dir/role-manager/role-manager.sh"
  local stub_calls_file="$tmpdir/role-manager-calls.log"

  mkdir -p "$capabilities_dir/role-manager"

  # Stub role-manager.sh — records calls instead of executing
  cat > "$stub_role_manager" <<'STUB'
#!/usr/bin/env bash
echo "role-manager called: $*" >> "$STUB_CALLS_FILE"
STUB
  chmod +x "$stub_role_manager"

  # Stub curl to return a controlled response
  local stub_curl="$tmpdir/bin/curl"
  mkdir -p "$tmpdir/bin"
  if [[ -n "$curl_response" ]]; then
    cat > "$stub_curl" <<CURLSTUB
#!/usr/bin/env bash
echo '$curl_response'
CURLSTUB
  else
    # Simulate curl failure (exits non-zero, no output)
    cat > "$stub_curl" <<'CURLSTUB'
#!/usr/bin/env bash
exit 1
CURLSTUB
  fi
  chmod +x "$stub_curl"

  env -i \
    PATH="$tmpdir/bin:$(dirname "$(command -v node)")" \
    HOME="$tmpdir" \
    CAPABILITIES_DIR="$capabilities_dir" \
    STUB_CALLS_FILE="$stub_calls_file" \
    "$@" \
    bash "$SYNC_SCRIPT" 2>&1 || true

  echo "$(cat "$stub_calls_file" 2>/dev/null)"
}

# ── Tests ─────────────────────────────────────────────────────────────────────

echo "=== role-sync-check.sh tests ==="
echo ""

echo "-- missing env vars → exits 0, no activation --"
tmpdir=$(mktemp -d)
output=$(env -i PATH="$PATH" HOME="$tmpdir" bash "$SYNC_SCRIPT" 2>&1 || true)
assert_exit_code "missing env vars exits 0" "0" \
  env -i PATH="$PATH" HOME="$tmpdir" bash "$SYNC_SCRIPT"
assert_contains "missing env vars prints skip message" "Required env vars not set" "$output"
rm -rf "$tmpdir"
echo ""

echo "-- API call fails (curl empty response) → exits 0, no activation --"
tmpdir=$(mktemp -d)
capabilities_dir="$tmpdir/capabilities"
mkdir -p "$capabilities_dir/role-manager"
echo "general-assistant" > "$capabilities_dir/.active-role"

# Stub role-manager
cat > "$capabilities_dir/role-manager/role-manager.sh" <<'EOF'
#!/usr/bin/env bash
echo "role-manager called: $*"
EOF
chmod +x "$capabilities_dir/role-manager/role-manager.sh"

output=$(
  CONTROL_PLANE_URL="http://localhost:19999" \
  EMPLOYEE_ID="ins_test" \
  INTERNAL_API_SECRET="secret" \
  CAPABILITIES_DIR="$capabilities_dir" \
  bash "$SYNC_SCRIPT" 2>&1 || true
)
assert_contains "curl fail prints skip message" "skipping" "$output"
# role-manager should NOT have been called
if echo "$output" | grep -q "role-manager called"; then
  echo "  FAIL: curl fail should not call role-manager"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: curl fail does not call role-manager"
  PASS=$((PASS + 1))
fi
rm -rf "$tmpdir"
echo ""

echo "-- DB role equals local role → no activation --"
tmpdir=$(mktemp -d)
capabilities_dir="$tmpdir/capabilities"
stub_log="$tmpdir/rm-calls.log"
mkdir -p "$capabilities_dir/role-manager"
echo "research-analyst" > "$capabilities_dir/.active-role"

cat > "$capabilities_dir/role-manager/role-manager.sh" <<EOF
#!/usr/bin/env bash
echo "activate \$*" >> "$stub_log"
EOF
chmod +x "$capabilities_dir/role-manager/role-manager.sh"

# Stub curl to return matching role
FAKE_CURL="$tmpdir/curl"
cat > "$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
echo '{"success":true,"data":{"capabilityRole":"research-analyst"}}'
EOF
chmod +x "$FAKE_CURL"

output=$(
  PATH="$tmpdir:$PATH" \
  CONTROL_PLANE_URL="https://fake.api" \
  EMPLOYEE_ID="ins_test" \
  INTERNAL_API_SECRET="secret" \
  CAPABILITIES_DIR="$capabilities_dir" \
  bash "$SYNC_SCRIPT" 2>&1 || true
)
rm_called=$(cat "$stub_log" 2>/dev/null || echo "")
assert_contains "in-sync prints sync message" "Role in sync" "$output"
assert_eq "in-sync: role-manager NOT called" "" "$rm_called"
rm -rf "$tmpdir"
echo ""

echo "-- DB role differs from local → role-manager activate called --"
tmpdir=$(mktemp -d)
capabilities_dir="$tmpdir/capabilities"
stub_log="$tmpdir/rm-calls.log"
mkdir -p "$capabilities_dir/role-manager"
echo "general-assistant" > "$capabilities_dir/.active-role"

cat > "$capabilities_dir/role-manager/role-manager.sh" <<EOF
#!/usr/bin/env bash
echo "called: \$*" >> "$stub_log"
EOF
chmod +x "$capabilities_dir/role-manager/role-manager.sh"

FAKE_CURL="$tmpdir/curl"
cat > "$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
echo '{"success":true,"data":{"capabilityRole":"financial-analyst"}}'
EOF
chmod +x "$FAKE_CURL"

PATH="$tmpdir:$PATH" \
  CONTROL_PLANE_URL="https://fake.api" \
  EMPLOYEE_ID="ins_test" \
  INTERNAL_API_SECRET="secret" \
  CAPABILITIES_DIR="$capabilities_dir" \
  bash "$SYNC_SCRIPT" 2>&1 || true

rm_called=$(cat "$stub_log" 2>/dev/null || echo "")
assert_contains "role drift calls role-manager activate" "called: activate financial-analyst" "$rm_called"
rm -rf "$tmpdir"
echo ""

echo "-- DB returns null capabilityRole → treated as general-assistant --"
tmpdir=$(mktemp -d)
capabilities_dir="$tmpdir/capabilities"
stub_log="$tmpdir/rm-calls.log"
mkdir -p "$capabilities_dir/role-manager"
echo "general-assistant" > "$capabilities_dir/.active-role"

cat > "$capabilities_dir/role-manager/role-manager.sh" <<EOF
#!/usr/bin/env bash
echo "called: \$*" >> "$stub_log"
EOF
chmod +x "$capabilities_dir/role-manager/role-manager.sh"

FAKE_CURL="$tmpdir/curl"
cat > "$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
# capabilityRole is null in DB
echo '{"success":true,"data":{"capabilityRole":null}}'
EOF
chmod +x "$FAKE_CURL"

output=$(
  PATH="$tmpdir:$PATH" \
  CONTROL_PLANE_URL="https://fake.api" \
  EMPLOYEE_ID="ins_test" \
  INTERNAL_API_SECRET="secret" \
  CAPABILITIES_DIR="$capabilities_dir" \
  bash "$SYNC_SCRIPT" 2>&1 || true
)
rm_called=$(cat "$stub_log" 2>/dev/null || echo "")
assert_contains "null capabilityRole treated as general-assistant" "Role in sync" "$output"
assert_eq "null role: no activation needed" "" "$rm_called"
rm -rf "$tmpdir"
echo ""

echo "-- role-manager.sh missing → exits 1 with error --"
tmpdir=$(mktemp -d)
capabilities_dir="$tmpdir/capabilities"
mkdir -p "$capabilities_dir"
echo "general-assistant" > "$capabilities_dir/.active-role"
# No role-manager.sh

FAKE_CURL="$tmpdir/curl"
cat > "$FAKE_CURL" <<'EOF'
#!/usr/bin/env bash
echo '{"success":true,"data":{"capabilityRole":"code-review"}}'
EOF
chmod +x "$FAKE_CURL"

exit_code=0
PATH="$tmpdir:$PATH" \
  CONTROL_PLANE_URL="https://fake.api" \
  EMPLOYEE_ID="ins_test" \
  INTERNAL_API_SECRET="secret" \
  CAPABILITIES_DIR="$capabilities_dir" \
  bash "$SYNC_SCRIPT" 2>&1 || exit_code=$?

assert_eq "missing role-manager exits 1" "1" "$exit_code"
rm -rf "$tmpdir"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────

echo "========================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "========================================"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
