#!/usr/bin/env bash
#
# gitnexus-fresh.sh — On-demand GitNexus refresh.
#
# GitNexus is NO LONGER rebuilt on every commit (it is the slowest step and its
# embeddings can crash in native code). It is kept ONLY for the edit-safety
# primitives that nothing else provides and CLAUDE.md 鐵律 mandate:
#   - impact   (blast radius + risk grading)
#   - explain  (PDG taint: source→sink)   [needs --pdg]
#   - rename   (call-graph-aware multi-file rename)
#   - detect_changes (vs base ref)
#
# Run this BEFORE a risky edit / rename / PR review so those reflect current code.
#
# Env:
#   AGENTIC_KNOWLEDGE_ENABLE_EMBEDDINGS=1   also rebuild GitNexus embeddings (opt-in; can crash)
#   AGENTIC_KNOWLEDGE_PDG=1                  also run the PDG pass (enables explain/taint; slower)

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$REPO_ROOT" ]] || { echo "[gitnexus-fresh] not in a git repo" >&2; exit 1; }
cd "$REPO_ROOT" || exit 1

ENABLE_EMBEDDINGS="${AGENTIC_KNOWLEDGE_ENABLE_EMBEDDINGS:-0}"
ENABLE_PDG="${AGENTIC_KNOWLEDGE_PDG:-0}"

# Run gitnexus at the MCP-aligned version via the shared fail-closed helper
# (single source of truth for the version-skew invariant). If the version can't
# be proven, gitnexus_aligned refuses (non-zero) and we error out below rather
# than write an index the MCP can't read.
if [[ -f "$REPO_ROOT/scripts/gitnexus-cmd.sh" ]]; then
  # shellcheck source=scripts/gitnexus-cmd.sh
  . "$REPO_ROOT/scripts/gitnexus-cmd.sh"
else
  echo "[gitnexus-fresh] 找不到 scripts/gitnexus-cmd.sh（版本對齊 helper）— 中止" >&2
  exit 1
fi

gx() { gitnexus_aligned "$@"; }

if [[ ! -d .gitnexus ]]; then
  echo "[gitnexus-fresh] .gitnexus 尚未初始化 — 本次以對齊版本進行首次 index（較久）" >&2
fi

PDG_FLAG=""
if [[ "$ENABLE_PDG" == "1" || "$ENABLE_PDG" == "true" ]]; then
  PDG_FLAG="--pdg"
fi

echo "[gitnexus-fresh] analyzing (force${PDG_FLAG:+, pdg})…"
if ! gx analyze --force --skip-agents-md $PDG_FLAG; then
  echo "[gitnexus-fresh] analyze failed" >&2
  exit 1
fi

if [[ "$ENABLE_EMBEDDINGS" == "1" || "$ENABLE_EMBEDDINGS" == "true" ]]; then
  echo "[gitnexus-fresh] rebuilding embeddings (opt-in)…"
  gx analyze --embeddings --force --skip-agents-md \
    || echo "[gitnexus-fresh] embeddings failed; non-embedding index kept (MCP still usable)" >&2
fi

echo "[gitnexus-fresh] done — impact / explain / rename / detect_changes now current"
