# AiScrum Pro — Agent Instructions

These instructions apply to all Copilot agents working in this repository.

## Project Overview

ACP-powered autonomous Scrum engine for GitHub Copilot CLI. Orchestrates full Scrum sprints programmatically via the Agent Client Protocol.

## Project Priorities

1. **Robustness over speed**: Avoid changes that fix one thing but break others
2. **Small, testable diffs**: Prefer incremental changes over large rewrites
3. **Config-driven**: Prefer configuration changes over code changes when possible

## Foundational Principle

- **Stakeholder Authority** — The agent NEVER changes priorities, scope, or closes issues on its own — if it has concerns, it escalates and waits.

## Repo Structure

- `src/` — TypeScript source code
- `src/acp/` — ACP client, session pool, permissions
- `src/ceremonies/` — Sprint ceremonies (refinement, planning, execution, review, retro)
- `src/enforcement/` — Quality gates, drift control, escalation, challenger
- `src/git/` — Worktree, merge, diff analysis
- `src/github/` — Issues, labels, milestones via gh CLI
- `src/documentation/` — Sprint logs, huddles, velocity tracking
- `tests/` — Test suite (Vitest)
- `prompts/` — Prompt templates for ACP sessions
- `docs/` — Documentation, constitution, architecture
- `scripts/` — Utility scripts

## Key Commands

```bash
# Install dependencies
npm install

# Run tests
npx vitest run

# Lint
npx eslint src/ tests/

# Type check
npx tsc --noEmit

# Build
npx tsc

# Run all checks
npm run check

# Dev mode
npx tsx src/index.ts
```

## Coding Conventions

- TypeScript with strict mode enabled
- Use type hints everywhere
- Zod for runtime validation of config and external data
- Keep code readable; avoid clever one-liners
- Preserve existing public APIs unless explicitly asked
- When changing logic, update or add tests

## Architectural Decisions

See `docs/architecture/ADR.md` for immutable architectural decisions.

## Safety

- Don't delete or overwrite output artifacts unless explicitly asked
- Don't edit `.env` or `.db` files directly
- Don't modify ADRs without explicit confirmation

## ⛔ Workflow Gates

**⛔ Gate 0: PROCESS OVER SPEED — Every code change requires: feature branch → PR → CI green → merge. No exceptions.**

1. **Every Change → Branch + PR**: `git checkout -b feat/<issue>-<name>` → commit → push → `gh pr create` → CI green → squash-merge.

### ⛔ Gate 1: CI Gate — Enforcement

```bash
gh run list --branch <branch> --limit 3   # ALL must show ✓
gh run view <run-id> --log-failed          # If any show ✗, diagnose
```

- **Do NOT merge on red. No exceptions.**
