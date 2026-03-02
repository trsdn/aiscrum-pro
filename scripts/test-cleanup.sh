#!/usr/bin/env bash
# scripts/test-cleanup.sh — Remove all test sprint artifacts
#
# Targets: trsdn/ai-scrum-test-project (the TEST repo, NOT this repo!)
#
# Usage: ./scripts/test-cleanup.sh [--keep-issues]
#
# Removes:
#   - All milestones (closed first, then deleted)
#   - All issues (deep-deleted via GraphQL)
#   - All test-sprint/* remote branches
#   - All test-sprint-*-state.json and test-sprint-*-log.md files
#   - Sprint worktrees for test issues
#
# Use --keep-issues to only clean milestones, branches, and files
# but leave the test issues open for re-use.

set -euo pipefail

REPO="trsdn/ai-scrum-test-project"
KEEP_ISSUES=false
if [[ "${1:-}" == "--keep-issues" ]]; then
  KEEP_ISSUES=true
fi

PREFIX="test-sprint"

echo "🧹 Test Cleanup: ${REPO}"
echo ""

# --- 1. Delete ALL milestones ---
echo "📋 Cleaning milestones..."
milestone_count=0
while IFS=$'\t' read -r num title state; do
  [[ -z "$num" ]] && continue
  if [[ "$state" == "open" ]]; then
    gh api -X PATCH "repos/${REPO}/milestones/${num}" -f state=closed >/dev/null 2>&1 || true
  fi
  gh api -X DELETE "repos/${REPO}/milestones/${num}" >/dev/null 2>&1 || true
  echo "  ❌ Deleted milestone: ${title}"
  ((milestone_count++)) || true
done < <(gh api "repos/${REPO}/milestones?state=all&per_page=100" --paginate -q '.[] | [.number, .title, .state] | @tsv' 2>/dev/null || echo "")

if [[ $milestone_count -eq 0 ]]; then
  echo "  (none found)"
fi

# --- 2. Delete ALL issues (deep clean via GraphQL) ---
if [[ "$KEEP_ISSUES" == false ]]; then
  echo ""
  echo "🎫 Deleting all issues..."
  issue_count=0
  for state in open closed; do
    while IFS=$'\t' read -r num node_id; do
      [[ -z "$num" ]] && continue
      gh api graphql -f query="mutation { deleteIssue(input: {issueId: \"${node_id}\"}) { clientMutationId } }" --silent 2>/dev/null || echo "  ⚠ Failed #$num"
      echo "  🗑  Deleted #${num}"
      ((issue_count++)) || true
    done < <(gh issue list --repo "${REPO}" --state "$state" --limit 300 --json number,id -q '.[] | [.number, .id] | @tsv' 2>/dev/null || echo "")
  done

  if [[ $issue_count -eq 0 ]]; then
    echo "  (none found)"
  fi
else
  echo ""
  echo "🎫 Keeping issues (--keep-issues flag)"
fi

# --- 3. Delete remote branches (via GitHub API) ---
echo ""
echo "🌿 Cleaning remote branches..."
branch_count=0
for pattern in "test-sprint/" "feat/" "fix/" "refactor/"; do
  while read -r branch_name; do
    [[ -z "$branch_name" ]] && continue
    gh api "repos/${REPO}/git/refs/heads/${branch_name}" -X DELETE --silent 2>/dev/null || true
    echo "  ❌ Deleted branch: ${branch_name}"
    ((branch_count++)) || true
  done < <(gh api "repos/${REPO}/branches?per_page=100" --paginate -q ".[].name | select(startswith(\"${pattern}\"))" 2>/dev/null || echo "")
done

if [[ $branch_count -eq 0 ]]; then
  echo "  (none found)"
fi

# --- 4. Delete state and log files in test repo ---
echo ""
echo "📄 Cleaning state files in test repo..."
TEST_REPO_DIR="${HOME}/dev/GitHub/ai-scrum-test-project"
file_count=0
if [[ -d "${TEST_REPO_DIR}/docs/sprints" ]]; then
  for f in "${TEST_REPO_DIR}"/docs/sprints/sprint-*-state.json "${TEST_REPO_DIR}"/docs/sprints/sprint-*-log.md "${TEST_REPO_DIR}"/docs/sprints/sprint-*-state.json.lock; do
    if [[ -f "$f" ]]; then
      rm "$f"
      echo "  ❌ Deleted: $(basename "$f")"
      ((file_count++)) || true
    fi
  done
fi
if [[ $file_count -eq 0 ]]; then
  echo "  (none found)"
fi

# --- 5. Clean deployed .aiscrum config (keep roles) ---
echo ""
echo "📄 Cleaning deployed config in test repo..."
for f in "${TEST_REPO_DIR}/.aiscrum/config.yaml" "${TEST_REPO_DIR}/.aiscrum/quality-gates.yaml"; do
  if [[ -f "$f" ]]; then
    rm "$f"
    echo "  ❌ Deleted: $(basename "$f")"
  fi
done

echo ""
echo "✅ Cleanup complete! (${REPO})"
echo ""
echo "▶ Re-create test data:"
echo "   ./scripts/test-setup.sh"
