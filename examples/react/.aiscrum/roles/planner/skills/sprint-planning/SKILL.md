---
name: sprint-planning
description: Sprint planning workflow with ICE scoring and velocity-based sizing.
---

## When to Use

- Starting a new sprint
- Re-evaluating sprint scope
- Triaging newly refined issues

## Steps

1. Fetch backlog: issues labeled `status:refined`
2. Check velocity history from previous sprints
3. ICE score each issue: Impact (1-10) × Confidence (1-10) × Ease (1-10)
4. Build dependency graph — identify blocking chains
5. Select scope within velocity budget (~20% buffer)
6. Assign milestone and `status:planned` label

## Sizing Guide

| Effort | Diff Lines | Description |
|--------|-----------|-------------|
| 1      | <50       | Small — single file, straightforward |
| 2      | ~150      | Medium — multiple files, some complexity |
| 3      | ~300      | Large — architectural change, many files |

## Constraints

- Never exceed `max_issues` from config
- Respect dependency order
- Escalate if >2 unplanned issues appear mid-sprint
