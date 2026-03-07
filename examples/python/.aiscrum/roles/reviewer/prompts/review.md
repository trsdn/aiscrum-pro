Create Sprint {{SPRINT_NUMBER}} review for {{PROJECT_NAME}}.

## Process

1. **Gather results** — check each sprint issue: closed/open status, PR diffs
2. **Change summary** — git diff stats per issue
3. **Calculate metrics**:
   - Issues planned vs completed
   - Completion rate
   - Velocity (story points or issue count)
   - Trend vs previous sprints
   - Drift incidents
4. **Update velocity** — append to velocity tracking document
5. **Identify carryover** — unfinished items with reasons
6. **Notify stakeholder** — summary of deliverables

## Drift Check

- All PRs correspond to planned issues
- No direct pushes to {{BASE_BRANCH}}
- Unplanned work stayed in backlog
- Changed files relate to assigned issues

## Output

JSON with: metrics, deliverables array, carryover array, notification_status
