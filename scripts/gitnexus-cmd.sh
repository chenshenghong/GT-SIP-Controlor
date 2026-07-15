#!/usr/bin/env bash
#
# gitnexus-cmd.sh — single source of truth for running GitNexus at the version
# that matches the MCP server, FAIL-CLOSED.
#
# Source this (`. scripts/gitnexus-cmd.sh`) and call `gitnexus_aligned <args>`.
#
# Invariant: the gitnexus version that WRITES the index must equal the version
# the MCP server READS it with. Otherwise a storage-version skew (e.g. CLI 1.6.8
# writes v41, an MCP pinned to 1.6.4 reads v40) makes the freshly-rebuilt index
# UNREADABLE to the very impact/rename/detect_changes tools we rebuilt it for.
#
# Why a shared helper: this exact alignment was previously re-implemented in
# gitnexus-gate.sh, gitnexus-fresh.sh AND the installer — three copies that
# drifted (each fell back differently to an UNPINNED `gitnexus@latest` or a
# global `gitnexus` of unknown version, i.e. the skew this is meant to prevent).
# One enforcement point can't drift.
#
# FAIL-CLOSED: if we cannot prove the version (no `gitnexus@<v>` in .mcp.json) or
# cannot run a pinned version (`npx` unavailable), we REFUSE to run — we never
# fall back to an unpinned/global gitnexus that could write an incompatible index.
# Callers decide what "refuse" means for them (gate: skip refresh; fresh: error).

# Read the pinned gitnexus version (incl. the literal "latest") from .mcp.json's
# mcpServers.gitnexus.args. Prints the version, or nothing if absent.
gitnexus_aligned_version() {
  python3 - <<'PY' 2>/dev/null
import json
try:
    args = json.load(open('.mcp.json'))['mcpServers'].get('gitnexus', {}).get('args', [])
    print(next((a.split('@', 1)[1] for a in args
                if isinstance(a, str) and a.startswith('gitnexus@')), ''))
except Exception:
    pass
PY
}

# Run gitnexus at the MCP-aligned version, e.g.:
#   gitnexus_aligned analyze --skip-agents-md
# Returns the gitnexus exit code on success, or 3/4 (fail-closed) without running.
# stdout/stderr of gitnexus pass through to the caller.
gitnexus_aligned() {
  local ver
  ver="$(gitnexus_aligned_version)"
  if [[ -z "$ver" ]]; then
    echo "[gitnexus] .mcp.json 沒有 gitnexus@<version> → 拒絕寫 index（無法保證與 MCP 同 storage 格式，會 skew）" >&2
    return 3
  fi
  # Must be an EXACT version (incl. prerelease like 1.6.4-rc.112) — never a mutable
  # dist-tag (latest) or range (^1.6 / ~1.6 / 1.6.x). The MCP server is a long-lived
  # process pinned to whatever its tag resolved to at startup; a later
  # `npx gitnexus@latest analyze` can resolve to a NEWER version and write a storage
  # format the running MCP can't read. Fail-closed on anything non-exact.
  if [[ ! "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    echo "[gitnexus] .mcp.json 的 gitnexus 版本 '$ver' 不是 exact semver（latest/range 在時間上會 skew）→ 拒絕寫 index。請在 .mcp.json pin 明確版本（如 gitnexus@1.6.8）。" >&2
    return 5
  fi
  if ! command -v npx >/dev/null 2>&1; then
    echo "[gitnexus] npx 不可用，無法以對齊版本 gitnexus@$ver 執行 → 拒絕（不退回未知版本的 global gitnexus）" >&2
    return 4
  fi
  npx -y "gitnexus@$ver" "$@"
}
