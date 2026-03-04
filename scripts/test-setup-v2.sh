#!/usr/bin/env bash
# scripts/test-setup-v2.sh — Alternative test issues for edge case testing
#
# Targets: trsdn/ai-scrum-test-project (the TEST repo, NOT this repo!)
#
# Usage: ./scripts/test-setup-v2.sh
#
# This set focuses on:
#   - Multi-file changes (tests scope enforcement)
#   - Bug-fix issues with reproduction steps (tests TDD flow)
#   - Refactoring issues (tests zero-change detection)
#   - Issues with dependencies (tests execution groups)
#   - Larger scope issues (tests diff-size limits)
#
# Run cleanup first: ./scripts/test-cleanup.sh

set -euo pipefail

REPO="trsdn/ai-scrum-test-project"
PREFIX="Sprint"

echo "🧪 Test Setup V2 (Edge Cases): ${REPO}"
echo ""

# Ensure labels exist
for lbl in "status:ready" "status:refined" "status:blocked" "human-decision-needed" \
           "type:idea" "type:enhancement" "type:chore" "bug" "priority:high" "priority:critical"; do
  gh label create "$lbl" --repo "${REPO}" --force 2>/dev/null || true
done

# --- Milestone creation ---
for n in 1 2; do
  milestone="${PREFIX} ${n}"
  if gh api "repos/${REPO}/milestones" --paginate -q ".[].title" 2>/dev/null | grep -qF "$milestone"; then
    echo "📋 Milestone exists: ${milestone}"
  else
    gh api "repos/${REPO}/milestones" -f "title=${milestone}" -f "description=Sprint ${n}" >/dev/null
    echo "📋 Created milestone: ${milestone}"
  fi
done

# --- Deploy .aiscrum config to test repo ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER_DIR="$(dirname "$SCRIPT_DIR")"
TEST_REPO_DIR="${HOME}/dev/GitHub/ai-scrum-test-project"

deploy_aiscrum() {
  local target_dir="$1"
  mkdir -p "$target_dir/.aiscrum"
  cp "$RUNNER_DIR/.aiscrum/config.test.yaml" "$target_dir/.aiscrum/config.yaml"
  if [ -f "$RUNNER_DIR/.aiscrum/quality-gates.yaml" ]; then
    cp "$RUNNER_DIR/.aiscrum/quality-gates.yaml" "$target_dir/.aiscrum/quality-gates.yaml"
  fi
  if [ -d "$RUNNER_DIR/.aiscrum/roles" ]; then
    cp -r "$RUNNER_DIR/.aiscrum/roles" "$target_dir/.aiscrum/" 2>/dev/null || true
  fi
  # Deploy pre-commit hook (prevents empty commits and runs basic checks)
  mkdir -p "$target_dir/.git/hooks"
  cat > "$target_dir/.git/hooks/pre-commit" << 'HOOK'
#!/usr/bin/env bash
# Pre-commit hook: prevent empty/zero-change commits and run basic checks
set -euo pipefail

# Check for empty commits (no staged changes)
if git diff --cached --quiet; then
  echo "❌ Pre-commit: No staged changes. Aborting empty commit."
  exit 1
fi

# Run lint if available
if [ -f package.json ] && grep -q '"lint"' package.json 2>/dev/null; then
  echo "🔍 Pre-commit: Running lint..."
  npm run lint --silent 2>/dev/null || {
    echo "❌ Pre-commit: Lint failed. Fix errors before committing."
    exit 1
  }
fi

# Run typecheck if available
if [ -f tsconfig.json ] && command -v npx &>/dev/null; then
  echo "🔍 Pre-commit: Running type check..."
  npx tsc --noEmit 2>/dev/null || {
    echo "❌ Pre-commit: Type check failed. Fix errors before committing."
    exit 1
  }
fi

echo "✅ Pre-commit checks passed."
HOOK
  chmod +x "$target_dir/.git/hooks/pre-commit"
  echo "📁 Deployed .aiscrum/ config + pre-commit hook to ${target_dir}"
}

# Deploy to local dev checkout if it exists
if [ -d "$TEST_REPO_DIR" ]; then
  deploy_aiscrum "$TEST_REPO_DIR"
fi

# Also deploy to /tmp clone used by sprint runner
TMP_REPO_DIR="/tmp/ai-scrum-test-project"
if [ -d "$TMP_REPO_DIR/.git" ]; then
  deploy_aiscrum "$TMP_REPO_DIR"
fi

# --- Resolve milestone numbers for API ---
MS1_NUM=$(gh api "repos/${REPO}/milestones" -q '.[] | select(.title=="Sprint 1") | .number' 2>/dev/null || echo "")
MS2_NUM=$(gh api "repos/${REPO}/milestones" -q '.[] | select(.title=="Sprint 2") | .number' 2>/dev/null || echo "")

# --- Fast issue creation via gh api ---
RESULTS_DIR=$(mktemp -d)
ISSUE_COUNT=0
MAX_PARALLEL=3
RUNNING=0

create_issue() {
  local title="$1" body="$2" labels_csv="$3" milestone_num="${4:-}"
  ((ISSUE_COUNT++)) || true
  local idx=$ISSUE_COUNT

  local label_args=()
  IFS=',' read -ra lbl_arr <<< "$labels_csv"
  for l in "${lbl_arr[@]}"; do
    label_args+=(-f "labels[]=$l")
  done

  (
    local api_args=(-X POST -f "title=${title}" -f "body=${body}" "${label_args[@]}")
    if [[ -n "$milestone_num" ]]; then
      api_args+=(-F "milestone=${milestone_num}")
    fi
    local num=""
    for attempt in 1 2 3; do
      num=$(gh api "repos/${REPO}/issues" "${api_args[@]}" -q '.number' 2>/dev/null) && break
      sleep $(( attempt * 2 ))
    done
    echo "${idx}|${num:-ERR}|${title}" > "${RESULTS_DIR}/${idx}.txt"
  ) &

  ((RUNNING++)) || true
  if (( RUNNING >= MAX_PARALLEL )); then
    wait
    RUNNING=0
    sleep 0.3
  fi
}

flush_batch() {
  wait
  RUNNING=0
  for f in $(ls "${RESULTS_DIR}"/*.txt 2>/dev/null | sort -V); do
    local line
    line=$(cat "$f")
    local num="${line#*|}" ; num="${num%%|*}"
    local title="${line##*|}"
    echo "  ✅ #${num}: ${title}"
    rm "$f"
  done
}

# ═══════════════════════════════════════════
# Sprint 1 Issues — Edge Case Focus (6)
# ═══════════════════════════════════════════
echo ""
echo "━━━ Sprint 1 Issues (6) ━━━"

# 1. Bug fix with reproduction steps — tests TDD flow
create_issue "fix: Logger crashes when log level is set to 'silent'" \
"## Bug Report
**Steps to reproduce:**
1. Set \`LOG_LEVEL=silent\` in environment
2. Start the application
3. Any log call throws \`TypeError: Cannot read properties of undefined\`

**Expected:** Application runs silently without crashes.
**Actual:** Crashes on first log statement.

## Acceptance Criteria
- [ ] Add null-check guard in logger initialization
- [ ] Add test: \`logger.info('test')\` does not throw when level is 'silent'
- [ ] Add test: no output is written when level is 'silent'

## Technical Notes
- File: \`src/logger.ts\`
- The \`pino\` constructor returns undefined transport when level is 'silent'" \
"bug,status:ready" "$MS1_NUM"

# 2. Simple single-file change
create_issue "test: Add missing test for empty array edge case in utils" \
"## Acceptance Criteria
- [ ] Add test: \`formatList([])\` returns empty string
- [ ] Add test: \`formatList(['a'])\` returns \`'a'\` (no comma)
- [ ] Add test: \`formatList(['a','b','c'])\` returns \`'a, b, c'\`

## Technical Notes
- File: \`tests/utils.test.ts\`
- Function under test: \`src/utils.ts\` → \`formatList()\`" \
"type:chore,status:ready" "$MS1_NUM"

# 3. Multi-file feature — tests scope control
create_issue "feat: Add health check endpoint that reports uptime and version" \
"## Acceptance Criteria
- [ ] GET \`/health\` returns JSON: \`{ status: 'ok', uptime: <seconds>, version: '<pkg version>' }\`
- [ ] Status code is 200 when healthy
- [ ] Uptime is calculated from process start time
- [ ] Version is read from \`package.json\`
- [ ] Add test covering the health check response format

## Technical Notes
- New file: \`src/health.ts\`
- Update: \`src/app.ts\` to register the route
- Test file: \`tests/health.test.ts\`" \
"type:enhancement,status:ready" "$MS1_NUM"

# 4. Config enhancement — small focused change
create_issue "feat: Support environment variable overrides for config values" \
"## Acceptance Criteria
- [ ] \`SPRINT_MAX_ISSUES\` env var overrides \`sprint.max_issues\` in config
- [ ] \`SPRINT_BASE_BRANCH\` env var overrides \`project.base_branch\`
- [ ] Env vars take precedence over config file values
- [ ] Add tests for each override
- [ ] Log a warning when an env var override is active

## Technical Notes
- File: \`src/config.ts\`
- Test: \`tests/config.test.ts\`" \
"type:enhancement,status:ready" "$MS1_NUM"

# 5. Priority: high — tests priority ordering
create_issue "fix: Status label not removed when issue transitions to done" \
"## Bug Report
When an issue is marked \`status:done\`, the previous \`status:in-progress\` label remains.

## Acceptance Criteria
- [ ] When setting \`status:done\`, remove all other \`status:*\` labels first
- [ ] Add test: after setting done, only \`status:done\` label exists
- [ ] Verify idempotent: setting done twice doesn't create duplicates

## Technical Notes
- File: \`src/github/labels.ts\`
- Test: \`tests/github/labels.test.ts\`" \
"bug,priority:high,status:ready" "$MS1_NUM"

# 6. Documentation — tests non-code changes
create_issue "docs: Add API reference for all exported functions" \
"## Acceptance Criteria
- [ ] Create \`docs/api-reference.md\`
- [ ] Document all public functions from \`src/index.ts\` exports
- [ ] Each function has: signature, description, parameters, return type, example
- [ ] Table of contents at the top

## Technical Notes
- New file: \`docs/api-reference.md\`
- Reference: \`src/index.ts\` for exports" \
"type:chore,status:ready" "$MS1_NUM"

flush_batch

# ═══════════════════════════════════════════
# Backlog Issues — Dependency Chain (4)
# ═══════════════════════════════════════════
echo ""
echo "━━━ Backlog — Dependency Chain (4) ━━━"

# These test execution group ordering
create_issue "feat: Add database connection pool module" \
"## Acceptance Criteria
- [ ] Create \`src/db/pool.ts\` with \`createPool(config)\` and \`getConnection()\`
- [ ] Pool respects \`maxConnections\` config
- [ ] Add \`closePool()\` for graceful shutdown
- [ ] Add tests for pool creation, connection checkout, and exhaustion

## Technical Notes
- New directory: \`src/db/\`
- No external dependencies needed (use in-memory mock)" \
"type:enhancement,status:ready"

create_issue "feat: Add query builder on top of connection pool" \
"## Acceptance Criteria
- [ ] Create \`src/db/query.ts\` with \`select()\`, \`insert()\`, \`update()\` methods
- [ ] Uses connection from pool module
- [ ] Returns typed results
- [ ] Add tests for each query type

## Dependencies
- Depends on: \"Add database connection pool module\"

## Technical Notes
- File: \`src/db/query.ts\`
- Requires: \`src/db/pool.ts\`" \
"type:enhancement,status:ready"

create_issue "feat: Add migration runner using query builder" \
"## Acceptance Criteria
- [ ] Create \`src/db/migrate.ts\` with \`runMigrations(dir)\`
- [ ] Tracks applied migrations in a \`_migrations\` table
- [ ] Runs migrations in filename order
- [ ] Add tests with mock migration files

## Dependencies
- Depends on: \"Add query builder on top of connection pool\"

## Technical Notes
- File: \`src/db/migrate.ts\`
- Requires: \`src/db/query.ts\`" \
"type:enhancement,status:ready"

create_issue "feat: Add data seed command using migration infrastructure" \
"## Acceptance Criteria
- [ ] Create \`src/db/seed.ts\` with \`seedDatabase()\`
- [ ] Uses query builder to insert sample data
- [ ] Idempotent: running twice doesn't duplicate data
- [ ] Add CLI command: \`npx tsx src/index.ts db:seed\`

## Dependencies
- Depends on: \"Add migration runner using query builder\"

## Technical Notes
- File: \`src/db/seed.ts\`
- Requires: \`src/db/migrate.ts\` and \`src/db/query.ts\`" \
"type:enhancement,status:ready"

flush_batch

# ═══════════════════════════════════════════
# Backlog Issues — Various (8)
# ═══════════════════════════════════════════
echo ""
echo "━━━ Backlog — Various (8) ━━━"

create_issue "fix: Race condition in concurrent event emission" \
"## Bug Report
When multiple events fire simultaneously, handlers receive events out of order.

## Acceptance Criteria
- [ ] Events are queued and processed sequentially
- [ ] Add mutex/lock to event dispatcher
- [ ] Add test: fire 100 events concurrently, verify order is preserved
- [ ] No deadlocks under high load

## Technical Notes
- File: \`src/events.ts\`" \
"bug,status:ready"

create_issue "refactor: Replace callback-based file reader with async/await" \
"## Acceptance Criteria
- [ ] Convert \`readConfig(callback)\` to \`async readConfig()\`
- [ ] All callers updated to use await
- [ ] No behavior change — same error handling
- [ ] Existing tests still pass (update test syntax if needed)

## Technical Notes
- File: \`src/config.ts\`
- Callers: \`src/cli.ts\`, \`src/init.ts\`" \
"type:chore,status:ready"

create_issue "feat: Add request rate limiter middleware" \
"## Acceptance Criteria
- [ ] Create \`src/middleware/rate-limiter.ts\`
- [ ] Configurable: max requests per window (default: 100/min)
- [ ] Returns 429 when limit exceeded
- [ ] Includes \`Retry-After\` header
- [ ] Add tests for normal flow, limit hit, and window reset

## Technical Notes
- New file: \`src/middleware/rate-limiter.ts\`
- Test: \`tests/middleware/rate-limiter.test.ts\`" \
"type:enhancement,status:ready"

create_issue "fix: Memory leak in WebSocket connection handler" \
"## Bug Report
Long-running WebSocket connections accumulate event listeners without cleanup.

## Acceptance Criteria
- [ ] Add \`removeAllListeners()\` call on connection close
- [ ] Add test: open+close 1000 connections, verify listener count stays bounded
- [ ] Add heartbeat timeout to detect stale connections

## Technical Notes
- File: \`src/ws/handler.ts\`" \
"bug,status:ready"

create_issue "feat: Add structured error codes to all API responses" \
"## Acceptance Criteria
- [ ] Define error code enum in \`src/errors.ts\`
- [ ] All error responses include \`code\`, \`message\`, \`details\`
- [ ] Codes are documented in \`docs/error-codes.md\`
- [ ] Add test: verify all error paths return structured errors

## Technical Notes
- New file: \`src/errors.ts\`
- Update: all route handlers" \
"type:enhancement,status:ready"

create_issue "test: Increase test coverage for edge cases in date utilities" \
"## Acceptance Criteria
- [ ] Add test: \`formatDate\` handles timezone boundaries correctly
- [ ] Add test: \`parseRelativeDate('2 days ago')\` returns correct timestamp
- [ ] Add test: \`isBusinessDay\` handles holidays
- [ ] Add test: leap year handling in date calculations
- [ ] Coverage for \`src/utils/date.ts\` reaches 95%

## Technical Notes
- File: \`tests/utils/date.test.ts\`
- Source: \`src/utils/date.ts\`" \
"type:chore,status:ready"

create_issue "feat: Add CLI progress bar for long-running operations" \
"## Acceptance Criteria
- [ ] Create \`src/cli/progress.ts\` with \`ProgressBar\` class
- [ ] Shows: percentage, ETA, elapsed time, items processed
- [ ] Works in both TTY and non-TTY (falls back to log lines)
- [ ] Add test for progress calculation and formatting

## Technical Notes
- New file: \`src/cli/progress.ts\`
- No external dependencies (use ANSI escape codes)" \
"type:enhancement,status:ready"

create_issue "refactor: Extract validation logic into shared validators module" \
"## Acceptance Criteria
- [ ] Create \`src/validators.ts\` with reusable validators
- [ ] Move validation from config.ts, cli.ts, api.ts into shared module
- [ ] All existing tests still pass
- [ ] Add tests for each validator function

## Technical Notes
- New file: \`src/validators.ts\`
- Refactor: \`src/config.ts\`, \`src/cli.ts\`, \`src/api.ts\`" \
"type:chore,status:ready"

flush_batch

# ═══════════════════════════════════════════
# Blocked & Decision Issues (4)
# ═══════════════════════════════════════════
echo ""
echo "━━━ Blocked & Decision Issues (4) ━━━"

create_issue "feat: Add OAuth2 provider integration" \
"## Acceptance Criteria
- [ ] Support Google and GitHub OAuth2 flows
- [ ] Store tokens securely
- [ ] Add refresh token rotation

## Blocked
Blocked by: Need security review approval before implementing auth changes." \
"type:enhancement,status:blocked"

create_issue "decision: Should we support multiple database backends?" \
"## Context
Currently we only support SQLite. Adding PostgreSQL or MySQL support would increase complexity.

## Options
1. SQLite only (simple, embedded)
2. Add PostgreSQL (more scalable)
3. Abstract with adapter pattern (flexible but complex)

## Need stakeholder input on scope and timeline." \
"human-decision-needed,status:blocked"

create_issue "feat: Real-time collaboration with CRDT" \
"## Idea
Use CRDTs for real-time collaborative editing in the dashboard.

## Blocked
Blocked by: Architecture decision on data sync strategy needed." \
"type:enhancement,status:blocked"

create_issue "decision: Minimum supported Node.js version" \
"## Context
We currently target Node 18+. Should we drop 18 and require 20+?

## Trade-offs
- Node 18 EOL: April 2025 (already past)
- Node 20: native fetch, better ESM support
- Node 22: even more features but less adoption" \
"human-decision-needed,status:blocked"

flush_batch

# --- Summary ---
rm -rf "${RESULTS_DIR}"

echo ""
echo "✅ Test setup V2 complete! (${REPO})"
echo ""
echo "   ${ISSUE_COUNT} total issues (6 in Sprint 1, rest in backlog)"
echo ""
echo "▶ Start test run:"
echo "   cd ${TEST_REPO_DIR} && npx tsx $(dirname "$0")/../src/index.ts web"
echo ""
echo "🧹 Clean up when done:"
echo "   ./scripts/test-cleanup.sh"
