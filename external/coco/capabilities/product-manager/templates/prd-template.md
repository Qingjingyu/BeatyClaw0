# PRD — {FEATURE_NAME}

**Version**: 1.0
**Status**: {Draft / In Review / Approved}
**Author**: Product Manager
**Date**: {DATE}
**Target release**: {Version / Sprint / Quarter}

---

## Problem Statement

**Who has this problem**: {User type / segment}
**Problem**: {What they can't do or what's broken}
**Frequency**: {How often they encounter this}
**Current workaround**: {What they do today instead}
**Cost of not solving**: {Impact on user or business if we don't build this}

---

## Proposed Solution

**What we're building**: {High-level description in 2-3 sentences}
**What this is NOT**: {Explicit scope boundaries — what won't be done}
**Hypothesis**: {If we build X, users will Y, leading to Z business outcome}

---

## Impact Analysis

**Systems affected**:

- {Service / API / database / user flow 1}
- {Service / API / database / user flow 2}

**User segments affected**:

- {Segment 1}: {How they're affected}
- {Segment 2}: {How they're affected}

**Dependencies**:

- Must ship before: {Feature or infra requirement}
- Must ship alongside: {Coordinated change}

---

## Requirements

### Functional Requirements

**Story 1**: As a {user type}, I want to {goal} so that {benefit}

Acceptance Criteria:

- Given {context}, when {action}, then {expected result}
- Given {context}, when {action}, then {expected result}
- Given {context}, when {action}, then {expected result}

**Story 2**: As a {user type}, I want to {goal} so that {benefit}

Acceptance Criteria:

- Given {context}, when {action}, then {expected result}

_(Add more stories as needed)_

### Non-Functional Requirements

- Performance: {e.g., Page load < 2s for 95th percentile}
- Scalability: {e.g., Must support N concurrent users}
- Accessibility: {e.g., WCAG 2.1 AA}
- Security: {e.g., No PII in logs}

### Out of Scope

- {Explicitly excluded feature 1}
- {Explicitly excluded feature 2}

---

## Test Cases

| Scenario    | Input            | Expected Result                        |
| ----------- | ---------------- | -------------------------------------- |
| Happy path  | {Normal input}   | {Expected output}                      |
| Edge case 1 | {Boundary input} | {Expected output}                      |
| Error state | {Invalid input}  | {Error message / graceful degradation} |

---

## Success Metrics

| Metric              | Baseline  | Target   | Measurement method | Timeline  |
| ------------------- | --------- | -------- | ------------------ | --------- |
| Primary: {metric}   | {current} | {target} | {how to measure}   | {by date} |
| Secondary: {metric} | {current} | {target} | {how to measure}   | {by date} |

**Leading indicators** (check within 2 weeks of launch):

- {Early signal that things are working}

**Guardrail metrics** (should not regress):

- {Metric that must not get worse}

---

## Rollback Plan

**Trigger**: {What signals that rollback is needed — e.g., error rate > X%, drop in metric Y, support tickets > Z}

**Mechanism**: {Feature flag / revert deploy / database migration revert}

- Step 1: {Action}
- Step 2: {Action}

**Owner**: {Who executes the rollback}
**Estimated time to rollback**: {Duration}
**Data impact**: {Any data written during the experiment that needs handling}

---

## Risks & Assumptions

| Type       | Description           | Likelihood | Impact  | Mitigation            |
| ---------- | --------------------- | ---------- | ------- | --------------------- |
| Assumption | {What must be true}   | —          | —       | Validate by: {method} |
| Risk       | {What could go wrong} | {H/M/L}    | {H/M/L} | {How to mitigate}     |

---

## Open Questions

- [ ] {Question 1} — Owner: {Name} — Due: {Date}
- [ ] {Question 2} — Owner: {Name} — Due: {Date}

---

_PRD by Product Manager — requires engineering review before development begins._
