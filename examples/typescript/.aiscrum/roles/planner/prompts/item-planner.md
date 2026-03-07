Create an implementation plan for issue #{{ISSUE_NUMBER}}: "{{ISSUE_TITLE}}"

## Issue Body

{{ISSUE_BODY}}

## Instructions

Analyze the codebase and produce a detailed plan. Do NOT make any changes.

1. Identify files to modify/create
2. Understand current code state and dependencies
3. Plan test strategy
4. Estimate diff size

## Output

JSON with:
- summary: one-line description
- steps: array of { action: "create"|"modify"|"test", file, details }
- test_strategy: what to test and how
- risks: potential issues
- estimated_diff_lines: number (must be under {{MAX_DIFF_LINES}})
