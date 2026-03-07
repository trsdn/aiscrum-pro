# Deployment & Operations Guide

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | ≥ 20 | `node --version` |
| GitHub CLI (`gh`) | Latest | `gh --version` |
| GitHub Copilot CLI | Latest | `gh copilot --version` |
| Git | ≥ 2.20 (worktree support) | `git --version` |
| GitHub authentication | Scopes: `repo`, `read:org` | `gh auth status` |

---

## Installation & Build

```bash
# Clone and install
git clone https://github.com/<owner>/ai-scrum-autonomous-v2.git
cd ai-scrum-autonomous-v2
npm ci

# Build
npm run build          # Compiles TypeScript to dist/

# Verify
ls dist/index.js       # Entry point
node dist/index.js --version

# Global install (optional)
npm link               # Makes `aiscrum` available globally
```

---

## Configuration

All configuration lives in `.aiscrum/config.yaml` at the project root. Initialize a project:

```bash
aiscrum init     # Creates .aiscrum/ + config template
```

### Configuration Sections

#### Project

```yaml
project:
  name: "my-project"
  base_branch: "main"          # Default branch for PRs and merges
```

#### Copilot / ACP

```yaml
copilot:
  executable: "copilot"                 # Copilot CLI binary name
  max_parallel_sessions: 4              # Concurrent ACP sessions
  session_timeout_ms: 600000            # 10 min timeout per prompt
  auto_approve_tools: true              # Auto-approve tool calls
  allow_tool_patterns: []               # Restrict tools (empty = all)
  mcp_servers: []                       # Global MCP servers
  instructions: []                      # Global instruction file paths
  phases:                               # Per-role configuration
    planner:
      model: "claude-sonnet-4"
      instructions: [".aiscrum/roles/planner/copilot-instructions.md"]
    worker:
      model: "claude-sonnet-4"
    reviewer:
      model: "claude-sonnet-4"
    test-engineer:
      model: "claude-sonnet-4"
```

#### Sprint

```yaml
sprint:
  prefix: "Sprint"                      # Milestone naming prefix
  max_issues: 8                         # Max issues per sprint
  max_issues_created_per_sprint: 10     # Rate limit for new issues
  max_retries: 2                        # Quality gate retry attempts
  max_drift_incidents: 2                # Drift threshold before escalation
  enable_challenger: true               # Challenger at sprint review
  enable_tdd: false                     # TDD mode (test-engineer first)
  auto_revert_drift: false              # Auto-revert drifted changes
  backlog_labels: []                    # Filter backlog by labels
```

#### Quality Gates

```yaml
quality_gates:
  require_tests: true
  require_lint: true
  require_types: true
  require_build: true
  max_diff_lines: 300                   # Max lines changed per issue
  test_command: ["npm", "test"]
  lint_command: ["npx", "eslint", "src/"]
  typecheck_command: ["npx", "tsc", "--noEmit"]
  build_command: ["npm", "run", "build"]
```

#### Git

```yaml
git:
  worktree_base: "../sprint-worktrees"  # Where worktrees are created
  branch_pattern: "{prefix}/{sprint}/issue-{issue}"
  auto_merge: true                      # Auto-merge PRs on success
  squash_merge: true                    # Squash commits on merge
  delete_branch_after_merge: true
```

#### Escalation & Notifications

```yaml
escalation:
  notifications:
    ntfy: false                         # Enable ntfy.sh notifications
    ntfy_topic: "my-aiscrum"      # ntfy topic name
```

### Environment Variable Substitution

Config values support `${VAR}` syntax for environment variables:

```yaml
copilot:
  mcp_servers:
    - type: http
      name: my-server
      url: "${MCP_SERVER_URL}"
```

---

## Running in Production

### Direct execution

```bash
# Development mode (TypeScript directly)
npx tsx src/index.ts run

# Production mode (compiled)
node dist/index.js run

# With web dashboard
aiscrum web --port 9100
```

### Process management

#### systemd

```ini
[Unit]
Description=AiScrum Pro
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/aiscrum
ExecStart=/usr/bin/node dist/index.js run
Restart=on-failure
RestartSec=30
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
```

#### pm2

```bash
pm2 start dist/index.js --name aiscrum -- run
pm2 save
pm2 startup
```

---

## Web Dashboard

```bash
aiscrum web --port 9100
```

- **HTTP**: Serves static files at `http://localhost:9100`
- **WebSocket**: Real-time events on the same port
- **Event replay**: Reconnecting clients receive buffered events (max 200)
- **Controls**: Pause/resume/stop sprint from the browser

---

## Monitoring & Diagnostics

### CLI commands

```bash
aiscrum status               # Current sprint state
aiscrum metrics              # Sprint metrics summary
aiscrum drift-report         # Drift analysis
aiscrum check-quality        # Run quality gate checks
```

### Log output

Logs use [pino](https://github.com/pinojs/pino) structured logging:

```bash
# Pretty output (development)
aiscrum run | npx pino-pretty

# JSON output (production) — redirect to file
aiscrum run 2>&1 > aiscrum.log

# Filter errors
cat aiscrum.log | jq 'select(.level >= 50)'
```

---

## Notifications

Push notifications via [ntfy.sh](https://ntfy.sh):

```bash
# Configure in .aiscrum/config.yaml:
escalation:
  notifications:
    ntfy: true
    ntfy_topic: "my-sprint-notifications"

# Or use the script directly:
scripts/copilot-notify.sh "✅ Sprint Complete" "All issues done"
scripts/copilot-notify.sh "🔔 Decision needed" "Escalation" "high"
```

Priority levels: `urgent`, `high`, `default`, `low`, `min`

---

## State Management

### State files

```
docs/sprints/
├── sprint-<N>-state.json          # Current sprint state
├── sprint-<N>-state.json.lock     # Exclusive lock (PID-based)
├── sprint-<N>-log.md              # Sprint execution log
└── velocity.md                    # Cross-sprint velocity tracking
```

### Crash recovery

- State writes use **atomic persistence** (`tmp → fsync → rename`) — incomplete writes cannot corrupt state
- Lock files contain the PID of the holding process; stale locks from dead processes are automatically recovered
- On restart, the runner loads saved state and resumes from the last completed phase

### Pause / Resume

```bash
# Via dashboard UI (pause/resume buttons)
# Or programmatically — the runner handles SIGINT gracefully
```

State is saved after each phase completes. Resuming picks up from `state.phase`.
