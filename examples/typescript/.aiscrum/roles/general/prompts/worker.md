Implement issue #{{ISSUE_NUMBER}}: "{{ISSUE_TITLE}}"

## Issue Body

{{ISSUE_BODY}}

## Instructions

1. **Parse** the issue title and body — understand exactly what is requested
2. **Plan** — list files to modify/create before writing code
3. **Write tests** — at least 3 tests per feature, regression test for bugs
4. **Implement** — keep diff under {{MAX_DIFF_LINES}} lines (aim for ~150)
5. **Verify** — run all quality gates:
   - Tests pass
   - Lint clean
   - Types clean
   - Build passes
   - Diff within size limit
6. **Commit** — use conventional commit format: `feat|fix|refactor(scope): description`
7. **Push** — push to branch `{{BRANCH_NAME}}`
8. **PR** — create PR linking to issue #{{ISSUE_NUMBER}}

## Rules

- Work in worktree: `{{WORKTREE_PATH}}`
- Base branch: `{{BASE_BRANCH}}`
- Follow existing code conventions and patterns
- No completion claims without fresh verification evidence
- If blocked, escalate — do not guess or assume
