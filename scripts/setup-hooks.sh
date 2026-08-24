#!/usr/bin/env bash
# Setup git hooks for local enforcement.
# Run once after clone: ./scripts/setup-hooks.sh
#
# Installs pre-commit and pre-push hooks that run quality gates
# before code can be committed or pushed.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# --git-common-dir resolves correctly in linked worktrees too (.git is a file there).
HOOKS_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)/hooks"
SOURCE_DIR="$REPO_ROOT/scripts/hooks"

mkdir -p "$HOOKS_DIR"

echo "🔧 Installing git hooks..."

for hook in pre-commit pre-push; do
  if [ -f "$SOURCE_DIR/$hook" ]; then
    cp "$SOURCE_DIR/$hook" "$HOOKS_DIR/$hook"
    chmod +x "$HOOKS_DIR/$hook"
    echo "  ✅ $hook installed"
  fi
done

echo ""
echo "✅ Git hooks installed. Gates are now enforced on commit and push."
echo ""
echo "  pre-commit: format + lint + typecheck (fast)"
echo "  pre-push:   full gate incl. tests + build"
echo ""
echo "  To bypass (emergencies only): git commit --no-verify / git push --no-verify"
