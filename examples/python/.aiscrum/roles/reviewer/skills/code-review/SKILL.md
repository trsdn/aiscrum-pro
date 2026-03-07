---
name: code-review
description: Review pull requests for correctness, security, and logic errors.
---

## When to Use

- Reviewing a PR before merge
- Auditing staged changes
- Checking Definition of Done compliance

## Steps

1. Read the diff: `gh pr diff <number>`
2. Check DoD: tests added/updated, lint clean, docs updated if needed
3. Run tests to verify they pass
4. Check scope: changes match issue scope — flag unrelated additions
5. Provide structured feedback with blocking vs. non-blocking findings

## Rules

- Do NOT modify code — only report findings
- Focus on correctness, security, and logic (ignore style/formatting)
- Flag missing tests as blocking
- Verify CI status before approving
