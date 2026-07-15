#!/usr/bin/env bash
#
# gitnexus-gate.sh — point-of-use freshness gate for GitNexus edit-safety tools.
#
# Wired as a PreToolUse hook on mcp__gitnexus__{impact,rename,detect_changes}.
# (explain/PDG taint is NOT gated here: it needs a separate `analyze --pdg` pass —
#  refresh it manually with `AGENTIC_KNOWLEDGE_PDG=1 pnpm gitnexus:fresh`.)
# GitNexus is no longer rebuilt on every commit (slow), so its index drifts. Rather
# than rely on a human/agent REMEMBERING to run `gitnexus:fresh` before a risky edit,
# this gate makes freshness a SYSTEM PROPERTY: right before one of those tools runs,
# it cheaply checks whether the index is behind HEAD and, only if so, refreshes first.
#
# Cost: ~50ms (string compare) when fresh — the common case. ~25s only when actually
# stale AND actually about to use an edit-safety tool, i.e. exactly when it's worth it.
# Self-deduping: after one refresh, lastCommit == HEAD, so back-to-back calls no-op.
#
# Always exits 0 (never blocks the tool): worst case the tool runs on a slightly stale
# index, which is no worse than before this gate existed.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$REPO_ROOT" ]] || exit 0
cd "$REPO_ROOT" || exit 0

META="$REPO_ROOT/.gitnexus/meta.json"
[[ -f "$META" ]] || exit 0   # not indexed yet — let the tool surface its own error

HEAD="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
LAST="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('lastCommit',''))" "$META" 2>/dev/null || echo '')"

# Fresh — fast no-op (the hot path).
[[ -n "$LAST" && "$LAST" == "$HEAD" ]] && exit 0

# Stale → refresh before the tool runs. Guard against concurrent refreshes (multiple
# agents on a shared worktree) with a pid-stamped mkdir lock + dead-pid reclaim.
LOCK="$REPO_ROOT/.gitnexus/gate-refresh.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # Reclaim a stranded lock: no pid file, dead owner, or older than 10 minutes.
  reclaim=0
  [[ ! -f "$LOCK/pid" ]] && reclaim=1
  [[ -f "$LOCK/pid" ]] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null || echo -1)" 2>/dev/null && reclaim=1
  [[ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]] && reclaim=1
  if [[ "$reclaim" == "1" ]]; then
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    echo "[gitnexus-gate] a refresh is already running — proceeding (results may lag one refresh)" >&2
    exit 0
  fi
fi
printf '%s\n' "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

echo "[gitnexus-gate] index stale (${LAST:0:7} → HEAD ${HEAD:0:7}) — refreshing before edit-safety tool…" >&2
# Refresh via the shared fail-closed helper, which runs gitnexus at the SAME
# version the MCP server uses (.mcp.json) so the rebuilt index is in a storage
# format the MCP can read. If the version can't be proven it REFUSES rather than
# risk a skew that would BREAK the impact/rename/detect_changes tools this gate
# protects. Non-force analyze inside the helper call is up-to-date-aware.
# Either way the gate never blocks the tool (always exit 0).
if [[ -f "$REPO_ROOT/scripts/gitnexus-cmd.sh" ]]; then
  # shellcheck source=scripts/gitnexus-cmd.sh
  . "$REPO_ROOT/scripts/gitnexus-cmd.sh"
  gitnexus_aligned analyze --skip-agents-md >/dev/null 2>&1 \
    || echo "[gitnexus-gate] 略過刷新（版本對不齊 MCP，或刷新失敗）— 用現有 index 繼續" >&2
else
  echo "[gitnexus-gate] 找不到 scripts/gitnexus-cmd.sh — 略過刷新，用現有 index 繼續" >&2
fi
exit 0
