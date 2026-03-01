#!/usr/bin/env bash
# scripts/test-cleanup.sh — Remove all test sprint artifacts
#
# Usage: ./scripts/test-cleanup.sh [--keep-issues]
#
# Removes:
#   - All "Test Sprint N" milestones (closed first, then deleted)
#   - All issues labeled "test-run" (closed)
#   - All test-sprint/* remote branches
#   - All test-sprint-*-state.json and test-sprint-*-log.md files
#   - Sprint worktrees for test issues
#
# Use --keep-issues to only clean milestones, branches, and files
# but leave the test issues open for re-use.

set -euo pipefail

KEEP_ISSUES=false
if [[ "${1:-}" == "--keep-issues" ]]; then
  KEEP_ISSUES=true
fi

PREFIX="test-sprint"
LABEL="test-run"

echo "🧹 Test Cleanup: Removing all test sprint artifacts"
echo ""

# --- 1. Close and delete test milestones ---
echo "📋 Cleaning milestones..."
milestone_count=0
while IFS=$'\t' read -r num title state; do
  [[ -z "$num" ]] && continue
  if [[ "$title" == "Test Sprint"* ]]; then
    # Close if open
    if [[ "$state" == "open" ]]; then
      gh api -X PATCH "repos/{owner}/{repo}/milestones/${num}" -f state=closed >/dev/null 2>&1 || true
    fi
    # Delete
    gh api -X DELETE "repos/{owner}/{repo}/milestones/${num}" >/dev/null 2>&1 || true
    echo "  ❌ Deleted milestone: ${title}"
    ((milestone_count++)) || true
  fi
done < <(gh api "repos/{owner}/{repo}/milestones?state=all" --paginate -q '.[] | [.number, .title, .state] | @tsv' 2>/dev/null || echo "")

if [[ $milestone_count -eq 0 ]]; then
  echo "  (none found)"
fi

# --- 2. Delete test issues (deep clean via GraphQL) ---
if [[ "$KEEP_ISSUES" == false ]]; then
  echo ""
  echo "🎫 Deleting test issues (label: ${LABEL})..."
  issue_count=0
  # Delete open AND closed issues with the test-run label
  for state in open closed; do
    while IFS=$'\t' read -r num node_id; do
      [[ -z "$num" ]] && continue
      gh api graphql -f query="mutation { deleteIssue(input: {issueId: \"${node_id}\"}) { clientMutationId } }" --silent 2>/dev/null || true
      echo "  🗑  Deleted issue #${num}"
      ((issue_count++)) || true
    done < <(gh issue list --label "${LABEL}" --state "$state" --limit 200 --json number,id -q '.[] | [.number, .id] | @tsv' 2>/dev/null || echo "")
  done

  if [[ $issue_count -eq 0 ]]; then
    echo "  (none found)"
  fi
else
  echo ""
  echo "🎫 Keeping test issues (--keep-issues flag)"
fi

# --- 3. Delete test branches (remote) ---
echo ""
echo "🌿 Cleaning remote branches..."
branch_count=0
while read -r branch; do
  [[ -z "$branch" ]] && continue
  branch_name="${branch#origin/}"
  if [[ "$branch_name" == "${PREFIX}/"* ]]; then
    git push origin --delete "$branch_name" 2>/dev/null || true
    echo "  ❌ Deleted branch: ${branch_name}"
    ((branch_count++)) || true
  fi
done < <(git branch -r --list "origin/${PREFIX}/*" 2>/dev/null || echo "")

if [[ $branch_count -eq 0 ]]; then
  echo "  (none found)"
fi

# Clean local branches too
while read -r branch; do
  [[ -z "$branch" ]] && continue
  branch_name=$(echo "$branch" | sed 's/^[* ]*//')
  if [[ "$branch_name" == "${PREFIX}/"* ]]; then
    git branch -D "$branch_name" 2>/dev/null || true
    echo "  ❌ Deleted local branch: ${branch_name}"
  fi
done < <(git branch --list "${PREFIX}/*" 2>/dev/null || echo "")

# --- 4. Delete state and log files ---
echo ""
echo "📄 Cleaning state and log files..."
file_count=0
sprints_dir="docs/sprints"

if [[ -d "$sprints_dir" ]]; then
  for f in "${sprints_dir}"/${PREFIX}-*-state.json "${sprints_dir}"/${PREFIX}-*-log.md; do
    if [[ -f "$f" ]]; then
      rm "$f"
      echo "  ❌ Deleted: ${f}"
      ((file_count++)) || true
    fi
  done
fi

if [[ $file_count -eq 0 ]]; then
  echo "  (none found)"
fi

# --- 5. Clean worktrees ---
echo ""
echo "🌲 Cleaning worktrees..."
worktree_base="../sprint-worktrees"
wt_count=0
if [[ -d "$worktree_base" ]]; then
  for wt in "${worktree_base}"/issue-*; do
    if [[ -d "$wt" ]]; then
      git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
      echo "  ❌ Removed worktree: ${wt}"
      ((wt_count++)) || true
    fi
  done
fi

if [[ $wt_count -eq 0 ]]; then
  echo "  (none found)"
fi

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "▶ Re-create test data:"
echo "   ./scripts/test-setup.sh"
