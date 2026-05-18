# Code Review Report — {FILENAME_OR_DESCRIPTION}

**Language**: {LANGUAGE}
**Review Date**: {REVIEW_DATE}
**Reviewer**: Code Review Expert

---

## Overall Verdict

**Status**: {APPROVE / REQUEST_CHANGES / NEEDS_REWRITE}
**Summary**: {1-2 sentence overall assessment}

---

## 🔴 P1 — Blocking Issues (Must Fix Before Merge)

### Issue 1: {ISSUE_TITLE}

**Location**: `{FILE}:{LINE_NUMBER}`

**Problem**:
{Description of the bug, security issue, or data-loss risk}

**Risk**:
{What could go wrong if this is not fixed}

**Fix**:

```{LANGUAGE}
{corrected code snippet}
```

_(Repeat for each P1 issue)_

---

## 🟡 P2 — Should Fix (Must Fix Before Merge)

### Issue 1: {ISSUE_TITLE}

**Location**: `{FILE}:{LINE_NUMBER}`

**Problem**: {Description}

**Fix**:

```{LANGUAGE}
{corrected code snippet}
```

_(Repeat for each P2 issue)_

---

## 🔵 P3 — Suggestions (Fix Encouraged)

- **{FILE}:{LINE}**: {Suggestion} — {Why it improves the code}

---

## ⚪ Nits (Optional)

- **{FILE}:{LINE}**: {Minor style / naming suggestion}

---

## Dimensions Checked

| Dimension       | Assessment                  |
| --------------- | --------------------------- |
| Correctness     | {Pass / Issues Found}       |
| Security        | {Pass / Issues Found}       |
| Performance     | {Pass / Issues Found}       |
| Maintainability | {Pass / Issues Found}       |
| Test Coverage   | {Pass / Issues Found / N/A} |

---

_Review by Code Review Expert — P1 and P2 issues must be resolved before this can be merged._
