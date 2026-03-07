# Troubleshooting Guide

Common failure modes, diagnostic steps, and recovery procedures.

---

## 1. ACP / Copilot CLI Failures

**Symptoms**: Process exit, connection timeout, `ECONNRESET`, auth errors

**Diagnosis**:
```bash
gh auth status              # Verify GitHub authentication
gh copilot --version        # Verify Copilot CLI is installed
```

**Retry behavior**:
- Transient errors (`timeout`, `ECONNRESET`, `ECONNREFUSED`) are retried automatically
- Max retries: **3**, with exponential backoff: `1s → 2s → 4s`
- Circuit breaker opens after 3 consecutive failures, resets after **60 seconds**
- Non-transient errors (process exit, auth failure) are **not retried**

**Recovery**:
- Re-authenticate: `gh auth login`
- Restart AiScrum Pro (sessions are cleaned up on restart)
- Check Copilot CLI version compatibility

---

## 2. GitHub CLI (`gh`) Failures

**Symptoms**: Exit code 4 (auth), `ECONNRESET`, `ETIMEDOUT`, rate limit errors

**Diagnosis**:
```bash
gh auth status                          # Check authentication
gh api rate_limit --jq '.rate'          # Check rate limits
```

**Recovery**:
- Re-authenticate: `gh auth login --scopes repo,read:org`
- Rate limits: Wait for reset (shown in `rate_limit` output)
- Network issues: Check connectivity, retry

---

## 3. Quality Gate Failures

**Symptoms**: Issue marked `status:blocked`, quality gate comment shows ❌

**Quality gate checks**:

| Check | What it verifies |
|-------|-----------------|
| `tests-exist` | Test files (`*.test.{ts,js,tsx,jsx}`) exist |
| `tests-pass` | Test command exits 0 |
| `lint-clean` | Lint command exits 0 |
| `types-clean` | Type check command exits 0 |
| `build-pass` | Build command exits 0 |
| `scope-drift` | Changed files match `expectedFiles` |
| `diff-size` | Lines changed ≤ `max_diff_lines` (default: 300) |

**Diagnosis**:
```bash
# Run quality checks manually in the worktree
cd <worktree-path>
npm test                    # tests-pass
npx eslint src/             # lint-clean
npx tsc --noEmit            # types-clean
npm run build               # build-pass
```

**Recovery**:
- Fix failing checks in the worktree
- Re-run: `aiscrum check-quality --branch <branch>`
- Adjust thresholds in `.aiscrum/config.yaml` under `quality_gates`

---

## 4. Merge Conflicts

**Symptoms**: PR merge fails, issue marked `status:blocked`, escalation comment posted

**Diagnosis**:
```bash
git diff main...<branch>    # View changes
gh pr view <number>         # Check PR status
```

**Prevention**:
- The file overlap detection system groups issues with shared `expectedFiles` into sequential execution groups
- Configure `expectedFiles` on issues for accurate overlap detection

**Recovery**:
- Resolve conflicts manually in the worktree
- Re-trigger merge: `gh pr merge <number> --squash`
- If unresolvable: close PR, re-execute issue on fresh base

---

## 5. State & Lock Issues

**Symptoms**: "Lock already held" error, stale state, version mismatch

**State files**:
```
<project>/docs/sprints/sprint-<N>-state.json      # Sprint state
<project>/docs/sprints/sprint-<N>-state.json.lock  # Lock file
```

**Diagnosis**:
```bash
# Check lock file
cat docs/sprints/sprint-*-state.json.lock     # Shows PID
ps -p <PID>                                    # Check if process is alive
```

**Recovery**:
- **Stale lock**: If the holding process is dead, the lock is automatically recovered on next access
- **Manual removal**: `rm docs/sprints/sprint-*-state.json.lock`
- **Version mismatch**: Delete the state file to start fresh (current version: `1`)

**Atomic write guarantee**: State uses `tmp → fsync → rename` pattern — incomplete writes cannot corrupt state.

---

## 6. Worktree Issues

**Symptoms**: Creation failure, orphaned worktrees, disk space

**Diagnosis**:
```bash
git worktree list                              # List all worktrees
ls -la <worktree_base>/                        # Check worktree directory
df -h                                          # Check disk space
```

**Recovery**:
- Remove orphaned worktree: `git worktree remove <path> --force`
- Clean all: `git worktree prune`
- Worktree base is configurable: `git.worktree_base` in config (default: `../sprint-worktrees`)

---

## 7. Milestone & Sprint Setup

**Symptoms**: "No open milestone" error, wrong sprint number

**Milestone naming**: Must match `"{prefix} {N}"` pattern (e.g., "Sprint 3", "Test Sprint 5")

**Diagnosis**:
```bash
gh api repos/{owner}/{repo}/milestones --jq '.[].title'   # List milestones
```

**Recovery**:
- Create milestone: `gh api repos/{owner}/{repo}/milestones -f title="Sprint N"`
- Ensure milestone is **open** (not closed)
- Check `sprint.prefix` in config matches milestone naming

---

## 8. Logging & Debugging

**Log levels**: `debug | info | warn | error` (default: `info`)

**Enable debug logging**:
```bash
LOG_LEVEL=debug aiscrum run
```

**Log formats**:
- **Interactive**: `pino-pretty` (colorized, human-readable)
- **File/pipe**: JSON format (machine-parseable)
- **File redirect**: Logs are written to `aiscrum.log` when the TUI dashboard is active

**Reading structured logs**:
```bash
# Pretty-print JSON logs
cat aiscrum.log | npx pino-pretty

# Filter by level
cat aiscrum.log | jq 'select(.level >= 40)'   # warn + error only
```

**Automatic redaction**: The following fields are automatically replaced with `[REDACTED]` in all log output:
- `password`, `token`, `secret`, `apiKey`, `authorization`

---

## 9. Escalation Behavior

| Level | Action | ntfy Priority | Sprint Impact |
|-------|--------|---------------|---------------|
| **MUST** | Creates issue + pauses sprint | `urgent` | Sprint paused |
| **SHOULD** | Creates issue | `high` | Sprint continues |
| **INFO** | Creates issue | `default` | Sprint continues |

MUST-level escalations require stakeholder intervention before the sprint resumes. Check for escalation issues:

```bash
gh issue list --label "escalation"
```
