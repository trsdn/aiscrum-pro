Plan Sprint {{SPRINT_NUMBER}} for {{PROJECT_NAME}}.

## Backlog

Select issues from the backlog for this sprint.

## Process

1. **Review eligible issues** — labeled `status:refined` but NOT `status:planned` or `status:in-progress`
2. **Apply priority rules**:
   - Stakeholder-flagged issues first
   - Bugs before features
   - ICE score (Impact × Confidence × Ease, each 1-10)
   - Dependency order
3. **Calculate capacity** — use 3-sprint velocity average with ~20% buffer
4. **Analyze dependencies** — identify blocking chains and parallelizable work
5. **Structure execution groups** — group parallel work, sequence dependent work
6. **Apply labels** — `status:planned` + milestone "Sprint {{SPRINT_NUMBER}}"

## Constraints

- Minimum issues: {{MIN_ISSUES}}
- Maximum issues: {{MAX_ISSUES}}
- Never exceed max — quality over quantity
- Escalate if insufficient capacity for critical issues

## Output

JSON with: selected_issues, execution_groups, effort_estimation, rationale
