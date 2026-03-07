# Changelog

## [0.4.0] — 2026-03-07

### Added
- GitHub Pages landing site at [trsdn.github.io/aiscrum-pro](https://trsdn.github.io/aiscrum-pro/) (PR #462)
- Example `.aiscrum/` configurations for TypeScript, Python, React, and Go (PR #464)
- 126 tests validating example configs against Zod schema and role structure (PR #465)
- SVG logo with horizontal, icon-only, and dark background variants (PR #459)

### Changed
- **Rebrand**: Renamed from "AI Scrum Sprint Runner" to "AiScrum Pro" across 40+ files (PR #458)
- Repo renamed: `ai-scrum-autonomous-v2` → `aiscrum-pro`
- README rewritten with compelling narrative, AI-Scrum framework reference, all 9 dashboard screenshots (PR #461)
- Logo PNGs regenerated with transparent backgrounds (PR #463)
- Fixed PR template and bug report template (pytest/ruff/mypy → npm/eslint/tsc)

### Removed
- Tracked junk files: `.mdviewerplus-preview.html`, `.copilot/session-state/` (PR #460)

## [0.3.0] — 2026-02-28

### Added
- Interactive ACP session control from web dashboard (#55, PR #178)
  - Send messages to running sessions, stop with confirmation
  - SessionController with message queue and stop signals
- Integration test for full sprint cycle event emissions (PR #176)
- Post-merge verification: runs tests + types on main after each merge (PR #176)
- Types split into 12 domain modules in `src/types/` (PR #177)
- SprintConfig decomposed into sub-configs: GitConfig, SessionConfig, ExecutionLimits (PR #177)
- Shift-left CI: build check in quality gate, replaces GitHub Actions (PR #172)
- 86+ new tests for untested modules (PR #170)
- Event bus moved to canonical `src/events.ts` location (PR #171)
- Review ceremony enriched with execution data (PR #171)
- Dashboard: event replay on connect, WebSocket backpressure (PR #171)
- Acceptance criteria validation before execution (PR #171)
- Scope-drift quality gate check per issue (PR #173)
- Challenger review wired into execution flow (PR #173)
- MUST escalation pauses sprint engine (PR #173)
- Quality gate config-driven from YAML (PR #173)
- ACP circuit breaker: 3 failures → 60s cooldown (PR #168)
- Zod response schemas for ACP responses (PR #168)
- Atomic state writes with tmp→fsync→rename (PR #166)
- ACP sendPrompt retry with exponential backoff (PR #166)

### Changed
- CLI split: `src/index.ts` (807→40 lines) → `src/cli/commands.ts` + `src/cli/helpers.ts` (PR #167)
- State management extracted to `src/state-manager.ts` (PR #168)
- Quality retry extracted to `src/ceremonies/quality-retry.ts` (PR #167)

### Removed
- Terminal UI (Ink/React): `src/tui/` deleted, `dashboard` CLI command removed (PR #174)
- GitHub Actions CI: `.github/workflows/ci.yml` deleted (PR #172)
- Dead code: `src/improvement/`, `src/enforcement/ci-cd.ts`, `src/acp/session-pool.ts` (PR #173)
- Dependencies: `ink`, `react`, `@types/react` (PR #174)

### Fixed
- Flaky WebSocket server tests (#159, PR #169)
- Duplicate velocity entries (#161, PR #169)
- Quality gate error categories (#160, PR #169)
- Milestone error messages (#152, PR #169)
- Carried-over issues (#162, PR #169)

## v0.2.0

### Added
- `/refine` ceremony — turns `type:idea` issues into concrete, acceptance-criteria-ready backlog issues
- `type:idea` label for lightweight stakeholder input
- Drift control — sprint scope lock, huddle drift checks, boundary review
- Spec-driven best practices — acceptance criteria gates, pre-implementation checks

### Changed
- Sprint cycle: refine → plan → start → execute → review → retro
- Labels+Milestones replace Project Board for status tracking
