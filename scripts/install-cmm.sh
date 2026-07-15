#!/usr/bin/env bash
#
# install-cmm.sh — Per-machine bootstrap for codebase-memory-mcp (CMM).
#
# Makes the CMM code-intelligence engine available to AI agents on THIS machine,
# for ALL projects (cross-project). Run once per machine (idempotent, safe to re-run).
# Cross-platform: install.sh handles macOS/Linux/Windows.
#
# Env:
#   CMM_INSTALL_DIR   binary install dir (default ~/.local/bin)
#   CMM_ALL_AGENTS=1  also wire Codex/Gemini/Zed/etc via the official multi-agent installer
#
# Cross-machine rollout (e.g. build server):
#   ssh user@host 'curl -fsSL .../install.sh | bash -s -- --skip-config' && ssh user@host 'codebase-memory-mcp install -y'
#   …or copy this script over and run it.

set -uo pipefail

BIN_NAME=codebase-memory-mcp
INSTALL_DIR="${CMM_INSTALL_DIR:-$HOME/.local/bin}"
INSTALL_URL="https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh"

# 1) binary -------------------------------------------------------------------
if command -v "$BIN_NAME" >/dev/null 2>&1; then
  echo "[cmm] binary present: $("$BIN_NAME" --version 2>&1)"
else
  echo "[cmm] installing binary → $INSTALL_DIR"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$INSTALL_URL" | bash -s -- --skip-config --dir "$INSTALL_DIR"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$INSTALL_URL" | bash -s -- --skip-config --dir "$INSTALL_DIR"
  else
    echo "[cmm] ERROR: need curl or wget to install" >&2; exit 1
  fi
  export PATH="$INSTALL_DIR:$PATH"
fi
command -v "$BIN_NAME" >/dev/null 2>&1 || {
  echo "[cmm] ERROR: '$BIN_NAME' not on PATH after install. Add '$INSTALL_DIR' to PATH." >&2; exit 1; }

# 2) Claude Code — user scope (available to every project on this machine) -----
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q "^${BIN_NAME}:"; then
    echo "[cmm] Claude MCP already registered (user scope)"
  else
    claude mcp add -s user "$BIN_NAME" -- "$BIN_NAME" \
      && echo "[cmm] Claude MCP registered (user scope — all projects)"
  fi
else
  echo "[cmm] claude CLI not found — register manually: claude mcp add -s user $BIN_NAME -- $BIN_NAME"
fi

# 3) Codex / Gemini / Zed / … — official multi-agent installer (opt-in) --------
if [[ "${CMM_ALL_AGENTS:-0}" == "1" ]]; then
  echo "[cmm] wiring all detected agents via '$BIN_NAME install -y'…"
  "$BIN_NAME" install -y || echo "[cmm] multi-agent install reported issues (non-fatal)"
else
  echo "[cmm] (set CMM_ALL_AGENTS=1 to also wire Codex/Gemini/Zed via '$BIN_NAME install -y')"
fi

echo "[cmm] done. Restart your AI agent to pick up the MCP server. Per repo, add a .cbmignore to exclude vendored/build noise."
