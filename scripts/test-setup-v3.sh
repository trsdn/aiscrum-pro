#!/usr/bin/env bash
# scripts/test-setup-v3.sh — Second test case set with different edge cases
#
# Targets: trsdn/ai-scrum-test-project (the TEST repo, NOT this repo!)
#
# Usage: ./scripts/test-setup-v3.sh
#
# This set focuses on:
#   - Configuration/YAML changes (tests non-code changes)
#   - Documentation-only issues (tests zero-change detection differently)
#   - Issues with explicit dependencies (tests execution group ordering)
#   - Duplicate/overlapping issues (tests planner dedup judgment)
#   - Large-scope issues (tests diff-size rejection)
#   - Priority override scenarios (tests priority:critical ordering)
#   - Issues requiring new directories (tests file creation)
#
# Run cleanup first: ./scripts/test-cleanup.sh

set -euo pipefail

REPO="trsdn/ai-scrum-test-project"
PREFIX="Sprint"

echo "🧪 Test Setup V3 (Advanced Edge Cases): ${REPO}"
echo ""

# Ensure labels exist
for lbl in "status:ready" "status:refined" "status:blocked" "human-decision-needed" \
           "type:idea" "type:enhancement" "type:chore" "bug" "priority:high" "priority:critical" \
           "type:documentation"; do
  gh label create "$lbl" --repo "${REPO}" --force 2>/dev/null || true
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
  mkdir -p "$target_dir/.git/hooks"
  cat > "$target_dir/.git/hooks/pre-commit" << 'HOOK'
#!/usr/bin/env bash
set -euo pipefail
if git diff --cached --quiet; then
  echo "❌ Pre-commit: No staged changes. Aborting empty commit."
  exit 1
fi
if [ -f package.json ] && grep -q '"lint"' package.json 2>/dev/null; then
  npm run lint --silent 2>/dev/null || { echo "❌ Lint failed."; exit 1; }
fi
if [ -f tsconfig.json ] && command -v npx &>/dev/null; then
  npx tsc --noEmit 2>/dev/null || { echo "❌ Type check failed."; exit 1; }
fi
echo "✅ Pre-commit checks passed."
HOOK
  chmod +x "$target_dir/.git/hooks/pre-commit"
  echo "📁 Deployed .aiscrum/ config + hooks to ${target_dir}"
}

if [ -d "$TEST_REPO_DIR" ]; then
  deploy_aiscrum "$TEST_REPO_DIR"
fi
TMP_REPO_DIR="/tmp/ai-scrum-test-project"
if [ -d "$TMP_REPO_DIR/.git" ]; then
  deploy_aiscrum "$TMP_REPO_DIR"
fi

# --- Fast issue creation via gh api ---
RESULTS_DIR=$(mktemp -d)
ISSUE_COUNT=0
MAX_PARALLEL=3
RUNNING=0

create_issue() {
  local title="$1" body="$2" labels_csv="$3"
  ((ISSUE_COUNT++)) || true
  local idx=$ISSUE_COUNT

  local label_args=()
  IFS=',' read -ra lbl_arr <<< "$labels_csv"
  for l in "${lbl_arr[@]}"; do
    label_args+=(-f "labels[]=$l")
  done

  (
    local api_args=(-X POST -f "title=${title}" -f "body=${body}" "${label_args[@]}")
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
# Group A — Simple Utility Issues (6)
# Tests: basic implementation, parallel execution
# ═══════════════════════════════════════════
echo ""
echo "━━━ Group A: Simple Utilities (6) ━━━"

create_issue "feat: Add string truncation utility" \
"## Acceptance Criteria
- [ ] Create \`src/string/truncate.ts\` with a \`truncate(str, maxLength, suffix?)\` function
- [ ] Default suffix is \`'...'\`
- [ ] Returns original string if shorter than maxLength
- [ ] Truncates and appends suffix when string exceeds maxLength
- [ ] Handles empty string input
- [ ] Add tests in \`tests/string/truncate.test.ts\` with ≥4 test cases

## Technical Notes
- Pure function, no side effects
- maxLength includes the suffix length" \
"status:ready,type:enhancement"

create_issue "feat: Add array chunk utility" \
"## Acceptance Criteria
- [ ] Create \`src/array/chunk.ts\` with a \`chunk<T>(arr: T[], size: number): T[][]\` function
- [ ] Splits array into groups of \`size\`
- [ ] Last chunk may be smaller than \`size\`
- [ ] Returns empty array for empty input
- [ ] Throws on size ≤ 0
- [ ] Add tests in \`tests/array/chunk.test.ts\` with ≥4 test cases

## Technical Notes
- Generic function, works with any element type" \
"status:ready,type:enhancement"

create_issue "feat: Add deep-freeze utility" \
"## Acceptance Criteria
- [ ] Create \`src/object/freeze.ts\` with a \`deepFreeze<T>(obj: T): Readonly<T>\` function
- [ ] Recursively freezes all nested objects
- [ ] Handles arrays (freezes array and elements)
- [ ] Returns the frozen object
- [ ] Does not modify primitive values
- [ ] Add tests in \`tests/object/freeze.test.ts\` with ≥4 test cases

## Technical Notes
- Uses Object.freeze recursively
- Must handle circular references gracefully (skip already-frozen objects)" \
"status:ready,type:enhancement"

create_issue "feat: Add retry utility with exponential backoff" \
"## Acceptance Criteria
- [ ] Create \`src/async/retry.ts\` with a \`retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>\` function
- [ ] Options: \`maxRetries\` (default 3), \`baseDelay\` (default 100ms), \`maxDelay\` (default 5000ms)
- [ ] Uses exponential backoff: delay = min(baseDelay * 2^attempt, maxDelay)
- [ ] Returns result on first success
- [ ] Throws last error after all retries exhausted
- [ ] Add tests in \`tests/async/retry.test.ts\` with ≥4 test cases

## Technical Notes
- Use setTimeout-based delays (not busy waiting)
- Tests should use fake timers or short delays" \
"status:ready,type:enhancement"

create_issue "feat: Add memoize utility for pure functions" \
"## Acceptance Criteria
- [ ] Create \`src/function/memoize.ts\` with a \`memoize<T>(fn: (...args: any[]) => T): (...args: any[]) => T\` function
- [ ] Caches results based on serialized arguments (JSON.stringify)
- [ ] Returns cached result for identical arguments
- [ ] Supports functions with multiple arguments
- [ ] Add \`cache.clear()\` method on the memoized function
- [ ] Add tests in \`tests/function/memoize.test.ts\` with ≥4 test cases

## Technical Notes
- Use Map for cache storage
- Only works with JSON-serializable arguments" \
"status:ready,type:enhancement"

create_issue "feat: Add type guard utilities" \
"## Acceptance Criteria
- [ ] Create \`src/guards/index.ts\` with type guard functions:
  - \`isString(value: unknown): value is string\`
  - \`isNumber(value: unknown): value is number\` (excludes NaN)
  - \`isNonNullable<T>(value: T): value is NonNullable<T>\`
  - \`isRecord(value: unknown): value is Record<string, unknown>\`
- [ ] All guards return boolean with proper type narrowing
- [ ] Add tests in \`tests/guards/index.test.ts\` with ≥3 tests per guard

## Technical Notes
- Each guard is a single-line function
- isNumber should return false for NaN and Infinity" \
"status:ready,type:enhancement"

flush_batch

# ═══════════════════════════════════════════
# Group B — Bug Fixes (3)
# Tests: TDD flow, regression tests
# ═══════════════════════════════════════════
echo ""
echo "━━━ Group B: Bug Fixes (3) ━━━"

create_issue "fix: parseNumber returns NaN for hex strings instead of parsed value" \
"## Bug Report

### Steps to Reproduce
1. Call \`parseNumber('0xFF')\`
2. Expected: \`255\` (parsed hex value)
3. Actual: \`NaN\` (treated as invalid)

### Root Cause
The \`parseNumber\` function in \`src/utils.ts\` uses \`Number()\` which handles hex correctly, but there's a pre-validation regex that rejects non-decimal strings.

### Acceptance Criteria
- [ ] \`parseNumber('0xFF')\` returns \`255\`
- [ ] \`parseNumber('0b1010')\` returns \`10\` (binary)
- [ ] \`parseNumber('0o17')\` returns \`15\` (octal)
- [ ] \`parseNumber('not-a-number')\` still returns \`NaN\`
- [ ] Add regression test that reproduces the bug before the fix

## Technical Notes
- File: \`src/utils.ts\`, function \`parseNumber\`
- The pre-validation regex \`/^-?\\d+(\\.\\d+)?$/\` is too restrictive" \
"status:ready,bug"

create_issue "fix: formatDuration shows '0 seconds' for sub-second durations" \
"## Bug Report

### Steps to Reproduce
1. Call \`formatDuration(500)\` (500ms)
2. Expected: \`'500ms'\` or \`'< 1 second'\`
3. Actual: \`'0 seconds'\`

### Root Cause
The \`formatDuration\` function in \`src/utils.ts\` floors the seconds calculation, losing sub-second precision.

### Acceptance Criteria
- [ ] \`formatDuration(500)\` returns \`'500ms'\`
- [ ] \`formatDuration(0)\` returns \`'0ms'\`
- [ ] \`formatDuration(1500)\` returns \`'1 second 500ms'\`
- [ ] \`formatDuration(60000)\` still returns \`'1 minute'\` (no ms shown for ≥1min)
- [ ] Add regression test that fails before the fix

## Technical Notes
- File: \`src/utils.ts\`, function \`formatDuration\`
- Add millisecond handling for durations < 60 seconds" \
"status:ready,bug"

create_issue "fix: slugify drops unicode characters instead of transliterating" \
"## Bug Report

### Steps to Reproduce
1. Call \`slugify('Über Cool Café')\`
2. Expected: \`'uber-cool-cafe'\` (transliterated)
3. Actual: \`'ber-cool-caf'\` (leading ü and trailing é dropped)

### Root Cause
The \`slugify\` function in \`src/utils.ts\` strips non-ASCII characters before lowercasing.

### Acceptance Criteria
- [ ] \`slugify('Über Cool Café')\` returns \`'uber-cool-cafe'\`
- [ ] \`slugify('naïve résumé')\` returns \`'naive-resume'\`
- [ ] \`slugify('日本語')\` returns empty string (CJK not transliterated)
- [ ] Basic ASCII slugification still works correctly
- [ ] Add regression test for unicode input

## Technical Notes
- File: \`src/utils.ts\`, function \`slugify\`
- Use \`.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')\` for diacritic removal" \
"status:ready,bug,priority:high"

flush_batch

# ═══════════════════════════════════════════
# Group C — Documentation Issues (3)
# Tests: zero-change detection for docs, markdown-only PRs
# ═══════════════════════════════════════════
echo ""
echo "━━━ Group C: Documentation (3) ━━━"

create_issue "docs: Add CONTRIBUTING.md with development setup guide" \
"## Acceptance Criteria
- [ ] Create \`CONTRIBUTING.md\` in project root
- [ ] Include sections: Prerequisites, Getting Started, Running Tests, Code Style, Pull Request Process
- [ ] Document \`npm install\`, \`npm test\`, \`npm run lint\` commands
- [ ] Include commit message format (conventional commits)
- [ ] Mention the \`.aiscrum/\` config directory and its purpose

## Technical Notes
- Look at existing README.md for project context
- Keep it concise — max 100 lines" \
"status:ready,type:documentation"

create_issue "docs: Add JSDoc comments to all exported functions in src/utils.ts" \
"## Acceptance Criteria
- [ ] Every exported function in \`src/utils.ts\` has a JSDoc comment
- [ ] Each JSDoc includes: description, @param tags, @returns tag, @example
- [ ] Examples are runnable (valid TypeScript)
- [ ] No changes to function implementations — documentation only

## Technical Notes
- File: \`src/utils.ts\`
- This is a docs-only change — no logic modifications" \
"status:ready,type:documentation"

create_issue "docs: Create architecture decision record for utility module structure" \
"## Acceptance Criteria
- [ ] Create \`docs/adr/001-utility-module-structure.md\`
- [ ] Follow ADR template: Title, Status, Context, Decision, Consequences
- [ ] Document the decision to use flat \`src/utils.ts\` vs. modular \`src/utils/*.ts\` structure
- [ ] Status should be \`proposed\`
- [ ] Include pros/cons of both approaches

## Technical Notes
- Create \`docs/adr/\` directory if it doesn't exist
- Reference existing code organization patterns" \
"status:ready,type:documentation"

flush_batch

# ═══════════════════════════════════════════
# Group D — Refactoring Issues (3)
# Tests: zero-change edge case, scope control
# ═══════════════════════════════════════════
echo ""
echo "━━━ Group D: Refactoring (3) ━━━"

create_issue "refactor: Extract string utilities from utils.ts into dedicated module" \
"## Acceptance Criteria
- [ ] Create \`src/string/index.ts\` containing string-related functions from \`src/utils.ts\`
- [ ] Move: \`slugify\`, \`truncate\`, \`capitalize\`, \`camelToKebab\`
- [ ] Re-export from \`src/utils.ts\` for backward compatibility
- [ ] All existing tests still pass without modification
- [ ] No new functionality — pure code movement

## Technical Notes
- Create \`src/string/\` directory
- Use re-exports: \`export { slugify, truncate } from './string/index.js'\`
- If functions don't exist yet, create stub implementations" \
"status:ready,type:chore"

create_issue "refactor: Replace magic numbers with named constants" \
"## Acceptance Criteria
- [ ] Create \`src/constants.ts\` for shared constants
- [ ] Replace magic numbers in \`src/utils.ts\`:
  - \`1000\` → \`MS_PER_SECOND\`
  - \`60\` → \`SECONDS_PER_MINUTE\`
  - \`3600\` → \`SECONDS_PER_HOUR\`
  - \`1024\` → \`BYTES_PER_KB\`
- [ ] All existing tests pass without modification
- [ ] Add tests for constant values in \`tests/constants.test.ts\`

## Technical Notes
- Export constants as \`const\` (not enum)
- Keep \`src/utils.ts\` importing from \`src/constants.ts\`" \
"status:ready,type:chore"

create_issue "refactor: Convert callback-style error handling to Result type" \
"## Acceptance Criteria
- [ ] Create \`src/result.ts\` with \`Result<T, E>\` type (\`{ ok: true; value: T } | { ok: false; error: E }\`)
- [ ] Add helper functions: \`ok(value)\`, \`err(error)\`, \`isOk(result)\`, \`isErr(result)\`
- [ ] Add \`unwrap(result)\` that returns value or throws error
- [ ] Add tests in \`tests/result.test.ts\` with ≥5 test cases
- [ ] Do NOT refactor existing code to use Result — just create the type and helpers

## Technical Notes
- Inspired by Rust's Result type
- Keep it simple — no monadic chaining for now" \
"status:ready,type:chore"

flush_batch

# ═══════════════════════════════════════════
# Group E — Priority & Dependency Scenarios (3)
# Tests: priority ordering, dependency chains
# ═══════════════════════════════════════════
echo ""
echo "━━━ Group E: Priority & Dependencies (3) ━━━"

create_issue "feat: Add EventEmitter wrapper with typed events" \
"## Acceptance Criteria
- [ ] Create \`src/events/emitter.ts\` with a \`TypedEmitter<Events>\` class
- [ ] Support \`on(event, handler)\`, \`off(event, handler)\`, \`emit(event, data)\`
- [ ] Type-safe: event names and handler signatures checked at compile time
- [ ] Add \`once(event, handler)\` for one-time listeners
- [ ] Add tests in \`tests/events/emitter.test.ts\` with ≥5 test cases

## Technical Notes
- Use TypeScript mapped types for event → handler mapping
- This is a standalone module with no dependencies

## Dependencies
None — can run in parallel with any other issue" \
"status:ready,type:enhancement,priority:critical"

create_issue "feat: Add event logging middleware (depends on EventEmitter)" \
"## Acceptance Criteria
- [ ] Create \`src/events/logger.ts\` with an \`eventLogger\` middleware
- [ ] Takes a \`TypedEmitter\` and logs all emitted events with timestamps
- [ ] Configurable log level (debug, info, warn)
- [ ] Can filter which events to log (include/exclude list)
- [ ] Add tests in \`tests/events/logger.test.ts\` with ≥3 test cases

## Technical Notes
- Depends on: EventEmitter wrapper (the typed emitter issue)
- Use console.log or a simple logger interface
- Tests should verify log output using a mock logger

## Dependencies
- Depends on the \`TypedEmitter\` implementation being available in \`src/events/emitter.ts\`" \
"status:ready,type:enhancement"

create_issue "feat: Add pipeline/compose utility for function composition" \
"## Acceptance Criteria
- [ ] Create \`src/function/pipeline.ts\`
- [ ] \`pipe(value, ...fns)\` — applies functions left-to-right: \`pipe(5, add1, double)\` → \`12\`
- [ ] \`compose(...fns)\` — creates a right-to-left composition: \`compose(double, add1)(5)\` → \`12\`
- [ ] Type-safe for up to 5 function arguments
- [ ] Add tests in \`tests/function/pipeline.test.ts\` with ≥4 test cases

## Technical Notes
- Use TypeScript overloads for type safety (up to 5 args)
- \`pipe\` is eager (immediate execution), \`compose\` is lazy (returns new function)" \
"status:ready,type:enhancement"

flush_batch

# ═══════════════════════════════════════════
# Group F — Blocked / Decision-Needed (4)
# Tests: planner correctly skips blocked issues
# ═══════════════════════════════════════════
echo ""
echo "━━━ Group F: Blocked / Decision-Needed (4) ━━━"

create_issue "feat: Add database connection pooling" \
"## Acceptance Criteria
- [ ] Create connection pool module
- [ ] Support configurable pool size
- [ ] Health check on connections

## Blocked
Waiting for stakeholder decision on which database driver to use.

## Dependencies
- Needs decision issue resolved first" \
"status:blocked,type:enhancement,human-decision-needed"

create_issue "decision: Choose logging framework" \
"## Decision Needed

The project needs a logging framework. Options:
1. **pino** — fast, JSON-first
2. **winston** — feature-rich, widely used
3. **console** — zero dependencies

## Impact
Affects all modules that need logging.

## Stakeholder Input Needed
Please select the preferred logging framework." \
"status:blocked,human-decision-needed"

create_issue "feat: GraphQL API layer" \
"## Acceptance Criteria
- [ ] Add GraphQL schema
- [ ] Implement resolvers
- [ ] Add query/mutation types

## Blocked
This is a large-scope feature that needs architectural review before starting." \
"status:blocked,type:enhancement,type:idea"

create_issue "feat: Real-time WebSocket notifications" \
"## Acceptance Criteria
- [ ] WebSocket server setup
- [ ] Event broadcasting
- [ ] Client reconnection logic

## Blocked
Depends on EventEmitter implementation and architectural decision on WebSocket library." \
"status:blocked,type:enhancement"

flush_batch

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Created ${ISSUE_COUNT} issues in ${REPO}"
echo ""
echo "   Group A: 6 simple utilities (status:ready)"
echo "   Group B: 3 bug fixes (status:ready)"
echo "   Group C: 3 documentation (status:ready)"
echo "   Group D: 3 refactoring (status:ready)"
echo "   Group E: 3 priority/dependency (status:ready, 1 critical)"
echo "   Group F: 4 blocked/decision (status:blocked)"
echo ""
echo "   Ready for sprint: 18 issues"
echo "   Blocked: 4 issues"
echo "   Total: 22 issues"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

rm -rf "$RESULTS_DIR"
