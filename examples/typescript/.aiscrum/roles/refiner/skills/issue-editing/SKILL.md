---
name: issue-editing
description: Create and edit GitHub issues via gh CLI.
---

## When to Use

- Updating issue body after refinement
- Managing labels during status transitions
- Adding documentation comments to issues

## Commands

- `gh issue view <number> --json title,body,labels` — read issue
- `gh issue edit <number> --body "<body>"` — update body
- `gh issue edit <number> --add-label "label"` — add label
- `gh issue edit <number> --remove-label "label"` — remove label
- `gh issue comment <number> --body "<comment>"` — add comment
- `gh issue create --title "..." --body "..." --label "..."` — create new issue

## Rules

- Always read the full issue before editing
- Show proposed body to user before saving
- Never remove labels without stating why
