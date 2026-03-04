#!/usr/bin/env bash
# scripts/test-setup.sh — Create a realistic test repo state for sprint runner testing
#
# Targets: trsdn/ai-scrum-test-project (the TEST repo, NOT this repo!)
#
# Usage: ./scripts/test-setup.sh
#
# Creates:
#   - "Sprint 1" milestone with 6 issues assigned (ready to run)
#   - "Sprint 2" milestone (empty, for auto-advance)
#   - ~15 backlog issues labeled status:ready (for refinement/planning)
#   - ~5 idea issues labeled type:idea (unrefined)
#
# Run cleanup first: ./scripts/test-cleanup.sh

set -euo pipefail

REPO="trsdn/ai-scrum-test-project"
PREFIX="Sprint"

echo "🧪 Test Setup: ${REPO}"
echo ""

# Ensure labels exist
for lbl in "status:ready" "status:refined" "status:blocked" "human-decision-needed" "type:idea" "type:enhancement" "type:chore" "bug"; do
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

# --- Deploy .aiscrum config to test repo (early, so dashboard works even if script is interrupted) ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER_DIR="$(dirname "$SCRIPT_DIR")"
TEST_REPO_DIR="${HOME}/dev/GitHub/ai-scrum-test-project"

if [ -d "$TEST_REPO_DIR" ]; then
  mkdir -p "$TEST_REPO_DIR/.aiscrum"
  cp "$RUNNER_DIR/.aiscrum/config.test.yaml" "$TEST_REPO_DIR/.aiscrum/config.yaml"
  if [ -f "$RUNNER_DIR/.aiscrum/quality-gates.yaml" ]; then
    cp "$RUNNER_DIR/.aiscrum/quality-gates.yaml" "$TEST_REPO_DIR/.aiscrum/quality-gates.yaml"
  fi
  if [ -d "$RUNNER_DIR/.aiscrum/roles" ]; then
    cp -r "$RUNNER_DIR/.aiscrum/roles" "$TEST_REPO_DIR/.aiscrum/" 2>/dev/null || true
  fi
  echo "📁 Deployed .aiscrum/ config to ${TEST_REPO_DIR}"
fi

# --- Resolve milestone numbers for API ---
MS1_NUM=$(gh api "repos/${REPO}/milestones" -q '.[] | select(.title=="Sprint 1") | .number' 2>/dev/null || echo "")
MS2_NUM=$(gh api "repos/${REPO}/milestones" -q '.[] | select(.title=="Sprint 2") | .number' 2>/dev/null || echo "")

# --- Fast issue creation via gh api (parallel, max 4 concurrent) ---
RESULTS_DIR=$(mktemp -d)
ISSUE_COUNT=0
MAX_PARALLEL=3
RUNNING=0

create_issue() {
  local title="$1" body="$2" labels_csv="$3" milestone_num="${4:-}"
  ((ISSUE_COUNT++)) || true
  local idx=$ISSUE_COUNT

  # Build label args: -f "labels[]=label1" -f "labels[]=label2"
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

# Flush remaining background jobs and print results
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

echo ""
echo "━━━ Sprint 1 Issues (6) ━━━"

create_issue "test: Add input validation to config loader" \
"## Acceptance Criteria
- [ ] Validate that \`max_issues\` is between 1 and 50
- [ ] Validate that \`session_timeout_ms\` is positive
- [ ] Return clear error message on invalid config
- [ ] Add unit tests for validation edge cases" \
"bug,status:ready" "$MS1_NUM"

create_issue "test: Add retry count to sprint log output" \
"## Acceptance Criteria
- [ ] Sprint log includes retry count per issue
- [ ] Format: \`Retries: N\` in huddle entry
- [ ] Zero retries shows \`Retries: 0\`
- [ ] Add test covering retry count display" \
"type:chore,status:ready" "$MS1_NUM"

create_issue "test: Improve error message for missing milestone" \
"## Acceptance Criteria
- [ ] Error message includes the milestone name that was not found
- [ ] Suggests creating the milestone with correct naming
- [ ] Error is logged at warn level, not error
- [ ] Add test for error message format" \
"bug,status:ready" "$MS1_NUM"

create_issue "test: Add elapsed time to quality gate output" \
"## Acceptance Criteria
- [ ] Quality gate result includes \`elapsed_ms\` field
- [ ] Each individual check has its own duration
- [ ] Total duration is sum of all checks
- [ ] Add tests for timing data" \
"type:enhancement,status:ready" "$MS1_NUM"

create_issue "test: Export sprint metrics as JSON" \
"## Acceptance Criteria
- [ ] \`sprint-runner metrics --sprint N --json\` outputs JSON
- [ ] JSON includes: velocity, first_pass_rate, avg_duration_ms
- [ ] JSON output is valid and parseable
- [ ] Add test for JSON output format" \
"type:enhancement,status:ready" "$MS1_NUM"

create_issue "test: Add issue title to branch name" \
"## Acceptance Criteria
- [ ] Branch pattern supports \`{title}\` placeholder
- [ ] Title is slugified (lowercase, hyphens, max 40 chars)
- [ ] Special characters are stripped
- [ ] Add tests for title slugification" \
"type:chore,status:ready" "$MS1_NUM"

flush_batch

echo ""
echo "━━━ Backlog Issues (15) ━━━"

create_issue "feat: Add sprint velocity chart to dashboard" \
"## Acceptance Criteria
- [ ] Bar chart showing planned vs completed points per sprint
- [ ] Data loaded from velocity.md
- [ ] Visible on a Metrics tab in the dashboard" \
"type:enhancement,status:ready"

create_issue "fix: Graceful shutdown doesn't wait for active ACP sessions" \
"## Acceptance Criteria
- [ ] SIGINT handler waits up to 30s for active sessions
- [ ] Sessions receive a stop signal before force-kill
- [ ] Clean exit with proper state persistence" \
"bug,status:ready"

create_issue "feat: Add issue dependency visualization in dashboard" \
"## Acceptance Criteria
- [ ] Dependencies displayed in IssueList component
- [ ] Blocked issues show what they depend on
- [ ] Visual indicator for dependency chain" \
"type:enhancement,status:ready"

create_issue "refactor: Extract WebSocket message handlers into separate module" \
"## Acceptance Criteria
- [ ] New file src/dashboard/ws-handlers.ts with handler functions
- [ ] ws-server.ts delegates to handlers
- [ ] No behavior changes, all existing tests pass" \
"type:chore,status:ready"

create_issue "feat: Add sprint burndown display to dashboard" \
"## Acceptance Criteria
- [ ] Progress bar or chart in SprintTab
- [ ] Updates in real-time as issues complete
- [ ] Shows planned vs actual completion rate" \
"type:enhancement,status:ready"

create_issue "fix: Duplicate status labels accumulate on issues" \
"## Acceptance Criteria
- [ ] setLabel removes previous status: labels before adding new one
- [ ] Only one status: label per issue at any time
- [ ] Unit test for label cleanup" \
"bug,status:ready"

create_issue "feat: Export sprint report as HTML" \
"## Acceptance Criteria
- [ ] HTML report generated from sprint log data
- [ ] Includes velocity, issue results, and timeline
- [ ] Saved to docs/sprints/sprint-N-report.html" \
"type:enhancement,status:ready"

create_issue "feat: Add dark/light theme toggle to dashboard" \
"## Acceptance Criteria
- [ ] Toggle button in Header component
- [ ] CSS variables for both themes
- [ ] Preference persisted in localStorage" \
"type:enhancement,status:ready"

create_issue "fix: Sprint log template missing retro improvements section" \
"## Acceptance Criteria
- [ ] Add improvements section to SPRINT-LOG-TEMPLATE.md
- [ ] createSprintLog populates it from retro results
- [ ] Existing logs unaffected" \
"bug,status:ready"

create_issue "feat: Add notification sound on sprint completion" \
"## Acceptance Criteria
- [ ] Browser notification API for sprint:complete event
- [ ] Optional audio alert (configurable)
- [ ] Falls back gracefully if notifications denied" \
"type:enhancement,status:ready"

create_issue "refactor: Consolidate issue status mapping into shared utility" \
"## Acceptance Criteria
- [ ] Single statusFromLabels() function in src/github/issues.ts
- [ ] Used by ws-server, commands, and store
- [ ] Unit tests for all status transitions" \
"type:chore,status:ready"

create_issue "feat: Add keyboard shortcuts to dashboard" \
"## Acceptance Criteria
- [ ] Space to pause/resume sprint
- [ ] 1-5 number keys for tab navigation
- [ ] ? to show shortcut help overlay" \
"type:enhancement,status:ready"

create_issue "fix: Event buffer replay sends events in wrong order" \
"## Acceptance Criteria
- [ ] Events replayed in chronological order on reconnect
- [ ] Timestamp preserved in buffer entries
- [ ] Test with rapid connect/disconnect cycles" \
"bug,status:ready"

create_issue "feat: Add session duration tracking to sprint metrics" \
"## Acceptance Criteria
- [ ] Track total ACP session time per sprint
- [ ] Include in sprint log: total_session_time_ms
- [ ] Break down by role (developer, reviewer, etc.)" \
"type:enhancement,status:ready"

create_issue "refactor: Replace string event names with typed enum" \
"## Acceptance Criteria
- [ ] Create SprintEventName enum in src/events.ts
- [ ] All emitTyped/onTyped calls use enum values
- [ ] No behavior changes, all tests pass" \
"type:chore,status:ready"

flush_batch

echo ""
echo "━━━ Idea Issues (5) ━━━"

create_issue "idea: Multi-repo sprint support" \
"Run sprints across multiple repositories simultaneously. Would need coordinated milestone management and cross-repo dependency tracking." \
"type:idea"

create_issue "idea: AI-powered sprint capacity estimation" \
"Use historical velocity data and issue complexity signals to automatically estimate sprint capacity instead of fixed max_issues config." \
"type:idea"

create_issue "idea: Slack/Discord integration for sprint notifications" \
"Alternative to ntfy — push sprint events to team chat channels with rich formatting and interactive buttons." \
"type:idea"

create_issue "idea: Visual diff preview in dashboard before merge" \
"Show a rendered diff view in the dashboard for each completed issue before auto-merge, allowing stakeholder review." \
"type:idea"

create_issue "idea: Agent performance leaderboard" \
"Track which agent configurations (model, prompts) produce the best results over time. Visualize in dashboard metrics tab." \
"type:idea"

flush_batch

echo ""
echo "━━━ Blocked Issues (3) ━━━"

create_issue "fix: ACP session pool exhaustion under load" \
"**Block reason:** Cannot reproduce reliably — needs stress test harness first.

## Acceptance Criteria
- [ ] Identify root cause of session pool exhaustion
- [ ] Add circuit breaker when pool is at capacity
- [ ] Add metrics for pool utilization
- [ ] Stress test with 10+ concurrent sessions" \
"bug,status:blocked"

create_issue "feat: GitHub App authentication for private repos" \
"**Block reason:** Requires GitHub App registration and OAuth flow — waiting for stakeholder to create the app.

## Acceptance Criteria
- [ ] Support GitHub App installation token auth
- [ ] Fallback to gh CLI auth when no app configured
- [ ] Document App setup in README" \
"type:enhancement,status:blocked"

create_issue "refactor: Migrate from pino to structured OpenTelemetry logging" \
"**Block reason:** Depends on OpenTelemetry SDK stabilization (v2.0) — not yet released.

## Acceptance Criteria
- [ ] Replace pino with @opentelemetry/api logging
- [ ] Preserve existing log levels and redaction
- [ ] Add trace context to sprint operations
- [ ] All existing tests pass with new logger" \
"type:chore,status:blocked"

flush_batch

echo ""
echo "━━━ Decision Issues (3) ━━━"

create_issue "decision: Should sprint auto-advance without stakeholder confirmation?" \
"Currently sprints auto-advance to the next milestone. Should we require explicit stakeholder confirmation between sprints?

**Options:**
1. Keep auto-advance (current behavior)
2. Pause and wait for stakeholder to confirm next sprint
3. Configurable per-project setting

**Impact:** Affects autonomous operation flow and stakeholder trust." \
"human-decision-needed"

create_issue "decision: Default merge strategy — squash vs rebase?" \
"We currently default to squash merge. Some teams prefer rebase for linear history.

**Options:**
1. Keep squash as default (current)
2. Switch to rebase as default
3. Auto-detect from repo settings

**Trade-offs:** Squash = cleaner history but loses granular commits. Rebase = preserves commits but noisier." \
"human-decision-needed"

create_issue "decision: Maximum retry count for failed issues" \
"Current default is 2 retries. Some complex issues need more attempts, but too many retries waste compute.

**Options:**
1. Keep max_retries=2 (current)
2. Increase to 3 with backoff
3. Make it per-issue based on complexity score

**Data:** ~15% of issues succeed on retry 2, <5% would benefit from retry 3." \
"human-decision-needed"

flush_batch

# Cleanup temp dir
rm -rf "${RESULTS_DIR}"

echo ""
echo "✅ Test setup complete! (${REPO})"
echo ""
TOTAL=$(gh issue list --repo "${REPO}" --state open --limit 300 --json number -q '. | length')
SPRINT1=$(gh api "repos/${REPO}/milestones" -q '.[] | select(.title=="Sprint 1") | .open_issues' 2>/dev/null || echo "?")
echo "   ${TOTAL} total issues (${SPRINT1} in Sprint 1, rest in backlog)"
echo ""
echo "▶ Start test run:"
echo "   cd ${TEST_REPO_DIR} && npx tsx ${RUNNER_DIR}/src/index.ts web"
echo ""
echo "🧹 Clean up when done:"
echo "   ./scripts/test-cleanup.sh"
