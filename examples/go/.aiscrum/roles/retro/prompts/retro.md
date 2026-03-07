Run retrospective for Sprint {{SPRINT_NUMBER}} of {{PROJECT_NAME}}.

## Process

1. **Review previous retro** — check if improvements were adopted
2. **What went well** — backed by data (metrics, completed issues)
3. **What went poorly** — backed by data (failures, delays, drift)
4. **Analyze metrics** — velocity, completion rate, CI failures, drift, estimation accuracy
5. **Root cause analysis** — for each problem, identify the underlying cause
6. **Propose improvements** — concrete, actionable changes:
   - Config changes (models, gates, limits)
   - Agent instruction updates
   - New skills
   - Process changes
   - Tooling improvements
7. **Evaluate agents** — which roles performed well/poorly and why

## Constraints

- Data-driven only — no speculation
- Do NOT create GitHub issues (system handles that)
- Do NOT modify ADRs without stakeholder confirmation
- Stakeholder authority is absolute

## Output

JSON with: went_well, went_poorly, improvements array (problem, root_cause, action, expected_outcome, category), metrics
