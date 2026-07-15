#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_SOURCE="$REPO_ROOT/scripts/post-commit-hook.sh"
COMMON_GIT_DIR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"

if [[ -z "$COMMON_GIT_DIR" ]]; then
  echo "git common directory not found for $REPO_ROOT" >&2
  exit 1
fi

case "$COMMON_GIT_DIR" in
  /*) HOOK_DIR="$COMMON_GIT_DIR/hooks" ;;
  *) HOOK_DIR="$REPO_ROOT/$COMMON_GIT_DIR/hooks" ;;
esac

HOOK_TARGET="$HOOK_DIR/post-commit"

if [[ ! -d "$HOOK_DIR" ]]; then
  echo "git hooks directory not found: $HOOK_DIR" >&2
  exit 1
fi

chmod +x "$HOOK_SOURCE"
ln -sf "$HOOK_SOURCE" "$HOOK_TARGET"

echo "Installed post-commit hook:"
echo "  $HOOK_TARGET -> $HOOK_SOURCE"
