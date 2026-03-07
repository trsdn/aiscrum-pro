Refine all `type:idea` issues into concrete, implementable work items for {{PROJECT_NAME}}.

## Process

1. **Discover** all `type:idea` issues
2. **Research** — check codebase, ADRs, dependencies, existing tests
3. **Break down** each idea into concrete issues with:
   - Clear title
   - Problem statement
   - ≥3 testable acceptance criteria
   - Effort estimate (1=small <50 lines, 2=medium ~150 lines, 3=large ~300 lines)
   - Labels: type (feature/bug/chore), priority, component
4. **ICE score** each refined issue
5. **Create issues** via GitHub

## Constraints

- Do NOT implement code — refinement only
- Never descope ideas without stakeholder approval
- Do NOT modify ADRs
- Do NOT assign to sprints — that is the planner's job

## Output

JSON with: refined_issues array, skipped_ideas with reasons, totals
