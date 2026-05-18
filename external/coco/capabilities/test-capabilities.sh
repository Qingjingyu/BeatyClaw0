#!/usr/bin/env bash
# test-capabilities.sh — Automated integrity tests for preset capability bundles.
# Run from any directory. Exit 0 = all pass, exit 1 = failures found.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPS_DIR="$SCRIPT_DIR"
ROLE_MANAGER_DIR="$CAPS_DIR/role-manager"
FOUNDATION_DIR="$CAPS_DIR/foundation"

pass=0
fail=0

_ok() {
  pass=$((pass + 1))
  printf "  \033[32m✓\033[0m %s\n" "$1"
}

_fail() {
  fail=$((fail + 1))
  printf "  \033[31m✗\033[0m %s\n" "$1"
}

# ── 1. registry.json integrity ──────────────────────────────────────────────

echo ""
echo "1. registry.json integrity"

if python3 -c "import json; json.load(open('$CAPS_DIR/registry.json'))" 2>/dev/null; then
  _ok "registry.json is valid JSON"
else
  _fail "registry.json is NOT valid JSON"
fi

REGISTRY_ROLE_COUNT=$(python3 -c "import json; d=json.load(open('$CAPS_DIR/registry.json')); print(len(d['roles']))")
if [ "$REGISTRY_ROLE_COUNT" -eq 13 ]; then
  _ok "registry.json contains 13 roles"
else
  _fail "registry.json contains $REGISTRY_ROLE_COUNT roles (expected 13)"
fi

# Check all required fields in each registry entry
REGISTRY_CHECK=$(python3 - << EOF
import json, sys

with open('$CAPS_DIR/registry.json') as f:
    d = json.load(f)

required = ['id', 'name', 'name_zh', 'icon', 'tagline_zh', 'suitable_for_zh', 'type', 'bundle_path']
errors = []
for role in d['roles']:
    for field in required:
        if not role.get(field):
            errors.append(f"role '{role.get('id','?')}' missing field '{field}'")

if errors:
    print("FAIL:" + "|".join(errors))
else:
    print("OK")
EOF
)

if [ "$REGISTRY_CHECK" = "OK" ]; then
  _ok "all registry entries have required fields"
else
  _fail "registry field errors: ${REGISTRY_CHECK#FAIL:}"
fi

# Check for duplicate IDs in registry
DUPE_CHECK=$(python3 - << EOF
import json
with open('$CAPS_DIR/registry.json') as f:
    d = json.load(f)
ids = [r['id'] for r in d['roles']]
dupes = [x for x in ids if ids.count(x) > 1]
print(','.join(set(dupes)) if dupes else "OK")
EOF
)
if [ "$DUPE_CHECK" = "OK" ]; then
  _ok "no duplicate role IDs in registry"
else
  _fail "duplicate role IDs in registry: $DUPE_CHECK"
fi

# ── 2. Bundle directory structure ───────────────────────────────────────────

echo ""
echo "2. Bundle directory structure"

ROLE_IDS=$(python3 -c "
import json
with open('$CAPS_DIR/registry.json') as f:
    d = json.load(f)
for r in d['roles']:
    print(r['bundle_path'])
")

REQUIRED_FILES=("system-prompt.md" "memory-init.json" "tools.json")

for bundle_path in $ROLE_IDS; do
  role_dir="$CAPS_DIR/$bundle_path"

  if [ -d "$role_dir" ]; then
    _ok "bundle dir exists: $bundle_path"
  else
    _fail "bundle dir MISSING: $bundle_path"
    continue
  fi

  for req_file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$role_dir/$req_file" ]; then
      _ok "$bundle_path/$req_file exists"
    else
      _fail "$bundle_path/$req_file MISSING"
    fi
  done

  # Validate memory-init.json is valid JSON
  if python3 -c "import json; json.load(open('$role_dir/memory-init.json'))" 2>/dev/null; then
    _ok "$bundle_path/memory-init.json is valid JSON"
  else
    _fail "$bundle_path/memory-init.json is NOT valid JSON"
  fi

  # Validate tools.json is valid JSON
  if python3 -c "import json; json.load(open('$role_dir/tools.json'))" 2>/dev/null; then
    _ok "$bundle_path/tools.json is valid JSON"
  else
    _fail "$bundle_path/tools.json is NOT valid JSON"
  fi

  # Check system-prompt.md is non-empty
  if [ -s "$role_dir/system-prompt.md" ]; then
    _ok "$bundle_path/system-prompt.md is non-empty"
  else
    _fail "$bundle_path/system-prompt.md is empty"
  fi

  # Check for unresolved [USER_NAME] placeholder in system prompt
  if ! grep -q '\[USER_NAME\]' "$role_dir/system-prompt.md"; then
    _ok "$bundle_path/system-prompt.md: no [USER_NAME] placeholder"
  else
    _fail "$bundle_path/system-prompt.md: contains literal [USER_NAME] placeholder"
  fi
done

# ── 3. registry.json ↔ filesystem consistency ──────────────────────────────

echo ""
echo "3. Registry ↔ filesystem consistency"

CONSISTENCY_CHECK=$(python3 - << EOF
import json, os

caps_dir = '$CAPS_DIR'
with open(os.path.join(caps_dir, 'registry.json')) as f:
    d = json.load(f)

errors = []
registered_paths = set()

for role in d['roles']:
    bp = role.get('bundle_path', '')
    registered_paths.add(bp)
    full = os.path.join(caps_dir, bp)
    if not os.path.isdir(full):
        errors.append(f"bundle_path '{bp}' does not exist on disk")

# Check for unregistered role dirs (skip role-manager and foundation)
skip = {'role-manager', 'foundation'}
for entry in os.listdir(caps_dir):
    full = os.path.join(caps_dir, entry)
    if os.path.isdir(full) and entry not in skip and not entry.startswith('.'):
        if entry not in registered_paths:
            errors.append(f"directory '{entry}' exists on disk but is NOT in registry.json")

if errors:
    print("FAIL:" + "|".join(errors))
else:
    print("OK")
EOF
)

if [ "$CONSISTENCY_CHECK" = "OK" ]; then
  _ok "registry bundle_paths match filesystem (no phantom dirs, no missing dirs)"
else
  IFS='|' read -ra ERRS <<< "${CONSISTENCY_CHECK#FAIL:}"
  for err in "${ERRS[@]}"; do
    _fail "consistency: $err"
  done
fi

# ── 4. Script syntax checks ─────────────────────────────────────────────────

echo ""
echo "4. Script syntax checks"

for script in \
  "$ROLE_MANAGER_DIR/role-manager.sh" \
  "$ROLE_MANAGER_DIR/role-inject-hook.sh"; do
  if [ -f "$script" ]; then
    script_name=$(basename "$script")
    if bash -n "$script" 2>/dev/null; then
      _ok "$script_name: bash syntax OK"
    else
      _fail "$script_name: bash syntax ERROR"
      bash -n "$script" 2>&1 | sed 's/^/     /'
    fi
  else
    _fail "$(basename "$script"): file not found"
  fi
done

# ── 5. foundation.md Python snippet validation ──────────────────────────────

echo ""
echo "5. foundation.md Python snippet validation"

FOUNDATION_MD="$FOUNDATION_DIR/foundation.md"

if [ ! -f "$FOUNDATION_MD" ]; then
  _fail "foundation.md not found at $FOUNDATION_MD"
else
  # Extract all fenced python/bash code blocks and test Python ones
  # foundation.md uses ```bash blocks with inline python3 -c commands — parse each one
  INLINE_COUNT=0
  while IFS= read -r line; do
    if [[ "$line" == *'python3 -c "'* ]]; then
      INLINE_COUNT=$((INLINE_COUNT + 1))
      PY_CODE=$(echo "$line" | sed 's/.*python3 -c "//;s/"[^"]*$//')
      if echo "$PY_CODE" | python3 -c "import ast,sys; ast.parse(sys.stdin.read())" 2>/dev/null; then
        _ok "foundation.md: inline python3 -c snippet $INLINE_COUNT parses OK"
      else
        _fail "foundation.md: inline python3 -c snippet $INLINE_COUNT has syntax error"
      fi
    fi
  done < "$FOUNDATION_MD"

  if [ $INLINE_COUNT -eq 0 ]; then
    _fail "foundation.md: no python3 -c snippets found (expected at least 1)"
  else
    _ok "foundation.md: validated $INLINE_COUNT inline python3 -c snippet(s)"
  fi
fi

# ── 6. role-manager: foundation not in role list ────────────────────────────

echo ""
echo "6. role-manager edge cases"

# Test that role-manager wouldn't list 'foundation' in fallback
if grep -q '"foundation" ] && continue' "$ROLE_MANAGER_DIR/role-manager.sh" 2>/dev/null; then
  _ok "role-manager.sh: foundation directory filtered from fallback listing"
else
  _fail "role-manager.sh: foundation directory may appear in fallback listing"
fi

# Test that registry validation is present in cmd_activate
if grep -q 'is_registered' "$ROLE_MANAGER_DIR/role-manager.sh" 2>/dev/null; then
  _ok "role-manager.sh: registry validation present in cmd_activate"
else
  _fail "role-manager.sh: registry validation missing from cmd_activate"
fi

# ── 7. setup-base.sh Python version pinning ─────────────────────────────────

echo ""
echo "7. setup-base.sh checks"

SETUP_BASE="$SCRIPT_DIR/../setup-base.sh"
if [ -f "$SETUP_BASE" ]; then
  if bash -n "$SETUP_BASE" 2>/dev/null; then
    _ok "setup-base.sh: bash syntax OK"
  else
    _fail "setup-base.sh: bash syntax ERROR"
  fi

  if grep -q 'openpyxl==' "$SETUP_BASE"; then
    _ok "setup-base.sh: Python libs have pinned versions"
  else
    _fail "setup-base.sh: Python libs are NOT pinned to specific versions"
  fi

  if grep -q 'python3-pip' "$SETUP_BASE"; then
    _ok "setup-base.sh: python3-pip is installed"
  else
    _fail "setup-base.sh: python3-pip installation not found"
  fi

  if grep -q 'ffmpeg' "$SETUP_BASE"; then
    _ok "setup-base.sh: ffmpeg is in apt-get install"
  else
    _fail "setup-base.sh: ffmpeg NOT found in apt-get install"
  fi

  if grep -q 'openai-whisper==' "$SETUP_BASE"; then
    _ok "setup-base.sh: openai-whisper is pinned to a specific version"
  else
    _fail "setup-base.sh: openai-whisper is NOT pinned (all pip packages must have pinned versions)"
  fi
else
  _fail "setup-base.sh not found at expected path"
fi

# ── 8. voice-asr transcribe.py ───────────────────────────────────────────────

echo ""
echo "8. voice-asr checks"

TRANSCRIBE_PY="$SCRIPT_DIR/../voice-asr/transcribe.py"

if [ -f "$TRANSCRIBE_PY" ]; then
  _ok "voice-asr/transcribe.py exists"
else
  _fail "voice-asr/transcribe.py MISSING"
fi

if python3 -m py_compile "$TRANSCRIBE_PY" 2>/dev/null; then
  _ok "voice-asr/transcribe.py: Python syntax OK"
else
  _fail "voice-asr/transcribe.py: Python syntax ERROR"
  python3 -m py_compile "$TRANSCRIBE_PY" 2>&1 | sed 's/^/     /'
fi

if grep -q "fp16=False" "$TRANSCRIBE_PY" 2>/dev/null; then
  _ok "voice-asr/transcribe.py: fp16=False set (CPU compatibility)"
else
  _fail "voice-asr/transcribe.py: fp16=False missing — will warn on CPU"
fi

if ! grep -q '"zh"' "$TRANSCRIBE_PY" 2>/dev/null && ! grep -q "'zh'" "$TRANSCRIBE_PY" 2>/dev/null; then
  _ok "voice-asr/transcribe.py: language not hardcoded (auto-detect)"
else
  _fail "voice-asr/transcribe.py: language is hardcoded — must use auto-detect"
fi

if grep -q 'VOICE_ASR_MODEL' "$TRANSCRIBE_PY" 2>/dev/null; then
  _ok "voice-asr/transcribe.py: VOICE_ASR_MODEL env var respected"
else
  _fail "voice-asr/transcribe.py: VOICE_ASR_MODEL env var not found — model is hardcoded"
fi

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: \033[32m$pass passed\033[0m, \033[31m$fail failed\033[0m"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ $fail -gt 0 ]; then
  exit 1
fi
exit 0
