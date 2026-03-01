#!/usr/bin/env bash
# scripts/e2e/setup.sh — Create test issues and milestone from scenarios.json
#
# Reads scenarios.json and creates GitHub issues with labels + milestone.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="trsdn/ai-scrum-test-project"
SCENARIOS="$SCRIPT_DIR/scenarios.json"

echo "🧪 E2E Setup: Creating test issues from scenarios.json"
echo ""

# Parse milestone name from scenarios
MILESTONE=$(jq -r '.milestone' "$SCENARIOS")

# Create milestone
echo "📋 Creating milestone: $MILESTONE"
if gh api "repos/$REPO/milestones" --paginate -q '.[].title' 2>/dev/null | grep -qF "$MILESTONE"; then
  echo "  ⏭  Already exists"
else
  gh api "repos/$REPO/milestones" -f "title=$MILESTONE" -f "description=E2E test sprint" >/dev/null
  echo "  ✅ Created"
fi

# Ensure labels exist
echo ""
echo "🏷️  Ensuring labels..."
for label in "status:ready" "status:in-progress" "status:done" "status:blocked" "status:planned" "type:escalation" "type:improvement" "human-decision-needed"; do
  if ! gh label list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -q "^${label}$"; then
    gh label create "$label" --repo "$REPO" --color "D4C5F9" 2>/dev/null || true
    echo "  ✅ Created: $label"
  fi
done

# Create issues from scenarios
echo ""
echo "🎫 Creating issues..."
issue_count=0
scenario_count=$(jq '.scenarios | length' "$SCENARIOS")

for i in $(seq 0 $((scenario_count - 1))); do
  title=$(jq -r ".scenarios[$i].title" "$SCENARIOS")
  body=$(jq -r ".scenarios[$i].body" "$SCENARIOS")
  expected=$(jq -r ".scenarios[$i].expected" "$SCENARIOS")
  labels=$(jq -r ".scenarios[$i].labels | join(\",\")" "$SCENARIOS")

  # Check if issue already exists
  if gh issue list --repo "$REPO" --json title -q '.[].title' 2>/dev/null | grep -qF "$title"; then
    echo "  ⏭  Already exists: $title"
    continue
  fi

  # Build gh issue create command (omit --label if empty)
  create_args=(--repo "$REPO" --title "$title" --body "$body" --milestone "$MILESTONE")
  if [ -n "$labels" ]; then
    create_args+=(--label "$labels")
  fi

  issue_num=$(gh issue create "${create_args[@]}" 2>/dev/null | grep -o '[0-9]*$')

  echo "  ✅ #$issue_num: $title (expected: $expected)"
  ((issue_count++)) || true
done

echo ""
echo "✅ Setup complete! Created $issue_count issues in milestone '$MILESTONE'"
echo ""
echo "▶ Next: ./scripts/e2e/run.sh"
