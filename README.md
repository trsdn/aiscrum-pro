# AI Scrum Sprint Runner

[![Optimized for GitHub Copilot CLI](https://img.shields.io/badge/Powered%20by-GitHub%20Copilot%20ACP-blue?logo=github)](https://docs.github.com/en/copilot)

**ACP-powered autonomous sprint engine** that orchestrates GitHub Copilot CLI via the Agent Client Protocol to run full Scrum sprints — planning, execution, review, and retrospective — without manual intervention.

The AI agent acts as **PO + Scrum Master**. The human is the **Stakeholder** with veto rights.

---

## Features

- **Full Sprint Lifecycle** — Refine → Plan → Execute → Review → Retro, all automated
- **Parallel Issue Execution** — Multiple issues worked on simultaneously via git worktrees
- **Quality Gates** — 7 checks enforced externally: tests-exist, tests-pass, lint-clean, types-clean, build-pass, scope-drift, diff-size
- **Web Dashboard** — Real-time sprint monitoring, issue tracking, ACP session viewer
- **Interactive Session Control** — Send messages to running ACP sessions, stop with confirmation
- **Agent Chat** — Open ad-hoc ACP sessions with pre-configured roles (researcher, planner, reviewer)
- **Sprint Navigation** — Browse historical sprints with instant loading via issue cache
- **Drift Control** — Detects and escalates scope drift automatically
- **Test Isolation** — Run test sprints with a separate prefix, fully isolated from production
- **Notifications** — Push notifications via [ntfy.sh](https://ntfy.sh) when tasks complete or input is needed

## Quick Start

### Prerequisites

- **Node.js** ≥ 20
- **GitHub Copilot CLI** with ACP support — `copilot --acp --stdio`
- **`gh` CLI** authenticated — `gh auth login`

### Install & Run

```bash
# Install dependencies + setup git hooks
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your NTFY_TOPIC (if using notifications)

# Launch web dashboard (auto-detects sprint from milestones)
npx tsx src/index.ts web
```

The dashboard opens at `http://localhost:9100` with live sprint status, issue tracking, and agent chat.

### Test Mode

Run the sprint runner against dummy issues without affecting your real backlog:

```bash
# 1. Create test data (2 sprints × 3 issues)
make test-setup

# 2. Launch dashboard in test mode
make test-web

# 3. Clean up everything when done
make test-cleanup
```

Test mode uses `sprint-runner.test.yaml` with `prefix: "Test Sprint"` — separate milestones, branches, state files, and dashboard view. See [Testing](#testing-the-sprint-runner) for details.

### Quality Gates

All code changes must pass quality gates before merge. Gates run locally — no CI dependency.

```bash
# Quick check (lint + types + tests)
npm run check

# Full gate (format + lint + types + tests + build) — runs on pre-push
npm run gate
```

Git hooks are installed automatically on `npm install`:
- **pre-commit**: format check + lint + typecheck (~15s)
- **pre-push**: full gate including tests + build (~60s)

To bypass in emergencies: `git commit --no-verify` / `git push --no-verify`

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `web` | Launch web dashboard (recommended) |
| `full-cycle` | Run complete sprint: refine → plan → execute → review → retro |
| `plan` | Run sprint planning only |
| `execute-issue --issue N --sprint N` | Execute a single issue |
| `check-quality --branch <branch>` | Run quality gates on a branch |
| `refine` | Refine `type:idea` issues into actionable work |
| `review --sprint N` | Run sprint review ceremony |
| `retro --sprint N` | Run sprint retrospective |
| `metrics --sprint N` | Show sprint metrics |
| `drift-report` | Analyze scope drift |
| `pause` / `resume` | Pause/resume sprint execution |
| `status` | Show active worker status |

**Global option:** `--config <path>` — use a different config file (default: `sprint-runner.config.yaml`)

### Examples

```bash
# Launch the dashboard for sprint 3
npx tsx src/index.ts web --sprint 3

# Run a complete sprint cycle (plan → execute → review → retro)
npx tsx src/index.ts full-cycle --sprint 3

# Execute a single issue in isolation
npx tsx src/index.ts execute-issue --issue 42 --sprint 3

# Run sprint planning only
npx tsx src/index.ts plan --sprint 3

# Check quality gates on a feature branch
npx tsx src/index.ts check-quality --branch feat/my-feature

# Use test config (isolated sprints)
npx tsx src/index.ts web --sprint 1 --config sprint-runner.test.yaml
```

---

## Web Dashboard

The dashboard (`sprint-runner web`) provides:

| Area | What It Does |
|------|-------------|
| **Sprint Header** | Current sprint, phase badge, elapsed timer, issue count |
| **Issue List** | All sprint issues with status (planned → in-progress → done/failed) |
| **Activity Log** | Real-time phase transitions, worker progress, errors |
| **Sprint Navigation** | Browse historical sprints with ← → buttons or arrow keys |
| **Session Viewer** | See active/completed ACP sessions and their output |
| **Agent Chat** | Open new ACP sessions with pre-configured roles |
| **GitHub Links** | Click issue numbers and sprint labels to open in GitHub |
| **Browser Notifications** | Alert when sprints complete or errors occur |

---

## Configuration

Configuration lives in `sprint-runner.config.yaml` (Zod-validated):

```yaml
project:
  name: "my-project"
  base_branch: "main"

sprint:
  prefix: "Sprint"        # Change to "Test Sprint" for isolation
  max_issues: 8
  max_retries: 2
  enable_challenger: true

copilot:
  max_parallel_sessions: 4
  session_timeout_ms: 600000
  phases:
    planner:
      model: "claude-opus-4.6"
    worker:
      model: "claude-sonnet-4.5"
    reviewer:
      model: "claude-opus-4.6"

quality_gates:
  require_tests: true
  require_lint: true
  require_types: true
  require_build: true
  max_diff_lines: 300

git:
  branch_pattern: "{prefix}/{sprint}/issue-{issue}"
  auto_merge: true
  squash_merge: true
```

### Sprint Prefix (Test Isolation)

The `sprint.prefix` field controls naming for **everything**:

| Prefix | Milestones | Branches | State Files |
|--------|-----------|----------|-------------|
| `"Sprint"` (default) | Sprint 1 | sprint/1/issue-N | sprint-1-state.json |
| `"Test Sprint"` | Test Sprint 1 | test-sprint/1/issue-N | test-sprint-1-state.json |

Switch configs to isolate test runs completely:

```bash
npx tsx src/index.ts web --config sprint-runner.test.yaml
```

---

## Testing the Sprint Runner

### Setup → Run → Cleanup

```bash
# Create test milestones and issues in GitHub
./scripts/test-setup.sh              # or: make test-setup

# Run dashboard against test data
npx tsx src/index.ts web --config sprint-runner.test.yaml    # or: make test-web

# Remove all test artifacts (milestones, issues, branches, files)
./scripts/test-cleanup.sh            # or: make test-cleanup
```

### What `test-setup.sh` Creates

- **2 milestones**: "Test Sprint 1", "Test Sprint 2"
- **6 issues**: 3 per sprint, with realistic acceptance criteria
- **Labels**: All tagged `test-run` + `status:ready`
- **Customizable**: `./scripts/test-setup.sh 3 4` → 3 sprints × 4 issues

### What `test-cleanup.sh` Removes

- All "Test Sprint" milestones (deleted from GitHub)
- All `test-run` labeled issues (closed)
- All `test-sprint/*` branches (local + remote)
- All `test-sprint-*-state.json` and `test-sprint-*-log.md` files
- Sprint worktrees

Use `--keep-issues` to preserve test issues for re-use:

```bash
./scripts/test-cleanup.sh --keep-issues
```

### Unit Tests

```bash
make test              # Run all tests (vitest)
make test-quick        # Fast fail (--bail 1)
make coverage          # With coverage report
make check             # Lint + types + tests
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                 Web Dashboard                     │
│  Sprint Status │ Issue List │ Chat │ Sessions     │
└────────┬───────────────────────────┬──────────────┘
         │ WebSocket                 │ REST API
┌────────┴───────────────────────────┴──────────────┐
│              Dashboard Server                      │
│  Event Bridge │ Issue Cache │ Chat Manager          │
└────────┬───────────────────────────────────────────┘
         │ SprintEventBus
┌────────┴───────────────────────────────────────────┐
│              Sprint Runner (State Machine)          │
│  init → refine → plan → execute → review → retro   │
├─────────────┬──────────────┬───────────────────────┤
│ Ceremonies  │ Enforcement  │ Infrastructure         │
│ · Planning  │ · Quality    │ · ACP Client           │
│ · Execution │ · Drift      │ · Git Worktrees        │
│ · Review    │ · Escalation │ · GitHub API (gh CLI)   │
│ · Retro     │ · Challenger │ · Sprint Docs           │
└─────────────┴──────────────┴───────────────────────┘
         │ ACP (Agent Client Protocol)
┌────────┴───────────────────────────────────────────┐
│          GitHub Copilot CLI (copilot --acp)         │
└────────────────────────────────────────────────────┘
```

### Directory Structure

```
src/
├── index.ts                 # CLI entry point (Commander.js)
├── config.ts                # Zod-validated YAML config loader
├── runner.ts                # Sprint lifecycle state machine
├── types.ts                 # Shared TypeScript interfaces
├── acp/                     # ACP client, session pool, permissions
├── ceremonies/              # Planning, execution, review, retro
├── enforcement/             # Quality gates, drift control, escalation, challenger
├── git/                     # Worktree, merge, diff analysis
├── github/                  # Issues, labels, milestones (via gh CLI)
├── documentation/           # Sprint logs, huddles, velocity
├── dashboard/               # Web UI server + static files
│   ├── ws-server.ts         # HTTP + WebSocket + REST API
│   ├── chat-manager.ts      # ACP chat session management
│   ├── issue-cache.ts       # In-memory sprint issue cache
│   └── public/              # HTML, CSS, JS (vanilla, no build step)

scripts/
├── test-setup.sh            # Create test issues and milestones
├── test-cleanup.sh          # Remove all test artifacts
└── copilot-notify.sh        # Push notifications via ntfy.sh

docs/
├── constitution/            # PROCESS.md, PHILOSOPHY.md
├── architecture/            # ADR.md
└── sprints/                 # State files, logs, velocity.md
```

---

## Makefile Targets

```bash
make help              # Show all targets
make check             # Lint + types + tests
make fix               # Auto-fix lint + format
make test              # Run tests
make test-quick        # Fast fail
make coverage          # Tests with coverage
make build             # Build TypeScript
make test-setup        # Create test sprint data
make test-cleanup      # Remove test artifacts
make test-web          # Run dashboard in test mode
make notify MSG="Done" # Send push notification
```

---

## Philosophy

> **The AI-Scrum Manifesto** — see [`docs/constitution/PHILOSOPHY.md`](docs/constitution/PHILOSOPHY.md)

*We have come to value:*
- **Autonomous execution** over constant approval
- **Verified evidence** over claimed completion
- **Sprint discipline** over feature chasing
- **Continuous process improvement** over static workflows

> **Focus, Quality, Incremental, Improve** — in that order.

## License

MIT
