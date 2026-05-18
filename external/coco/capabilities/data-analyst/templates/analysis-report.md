# Data Analysis Report — {DATASET / QUESTION}

**Dataset**: {Name, source, date range}
**Analysis Question**: {The specific business question this analysis answers}
**Analysis Date**: {DATE}
**Analyst**: Data Analyst

---

## Data Quality Assessment

| Check                   | Result                   |
| ----------------------- | ------------------------ |
| Total rows              | {N}                      |
| Total columns           | {N}                      |
| Time range              | {Start} to {End}         |
| Null rate (key columns) | {Column: X%, Column: X%} |
| Duplicates found        | {N rows removed / None}  |
| Outliers flagged        | {Description or None}    |
| Data type issues        | {Description or None}    |

**Data quality verdict**: {Reliable / Use with caution (reason) / Not suitable for analysis (reason)}

---

## Key Findings

### Finding 1: {Headline}

{1-2 sentence explanation}
**Supporting data**: {Metric, value, comparison}
**Confidence**: {High / Medium / Low}
**Source**: {Column / calculation}

### Finding 2: {Headline}

{Explanation}
**Supporting data**: {Metric}
**Confidence**: {Level}

### Finding 3: {Headline}

{Explanation}

---

## Visualizations Recommended

| Chart          | X-axis    | Y-axis   | Why                     |
| -------------- | --------- | -------- | ----------------------- |
| {Line chart}   | {Date}    | {Metric} | {Shows trend over time} |
| {Bar chart}    | {Segment} | {Count}  | {Compares categories}   |
| {Scatter plot} | {Var A}   | {Var B}  | {Shows correlation}     |

---

## Detailed Analysis

### Distribution Summary

{Key distributions, central tendency, spread for important variables}

### Trend Analysis

{If time-series data: growth rates, seasonality, inflection points}

### Segmentation

{Breakdown by key dimensions — which segments drive the most impact}

### Statistical Tests (if applicable)

| Test                          | Hypothesis | Result             | p-value | Conclusion        |
| ----------------------------- | ---------- | ------------------ | ------- | ----------------- |
| {t-test / chi-squared / etc.} | {H0: ...}  | {Accept/Reject H0} | {p}     | {What this means} |

---

## Reproducible Code

```python
import pandas as pd
import numpy as np

# Load data
df = pd.read_csv('{filename}')

# Key analysis steps
{reproducible code}
```

---

## Limitations

- {What this data cannot tell us}
- {Sample size caveats or selection bias}
- {Confounders not controlled for}

---

## Recommended Next Steps

1. {Action based on finding 1}
2. {Action based on finding 2}
3. {Further analysis worth doing}

---

_Analysis by Data Analyst — all statistics at α = {ALPHA} significance threshold._
