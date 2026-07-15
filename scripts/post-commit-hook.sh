#!/usr/bin/env bash

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  exit 0
fi

cd "$REPO_ROOT" || exit 0

PROJECT_NAME="${AGENTIC_KNOWLEDGE_PROJECT_NAME:-GT-SIP-Controlor}"
ASYNC_MODE="${AGENTIC_KNOWLEDGE_HOOK_ASYNC:-1}"
HOOK_LOG_DIR="${AGENTIC_KNOWLEDGE_HOOK_LOG_DIR:-/tmp}"
LOCK_TIMEOUT_SECS="${AGENTIC_KNOWLEDGE_LOCK_TIMEOUT_SECS:-600}"
VECTOR_INDEX_ENABLED="${AGENTIC_KNOWLEDGE_VECTOR_INDEX:-1}"
VECTOR_PROVIDER="${AGENTIC_KNOWLEDGE_VECTOR_PROVIDER:-gitnexus}"
VECTOR_MODEL="${AGENTIC_KNOWLEDGE_VECTOR_MODEL:-Snowflake/snowflake-arctic-embed-xs}"
# Code-graph engine (codebase-memory-mcp). Fast (~5s incremental, self-contained
# binary) so it runs on every commit. GitNexus is NO LONGER in the hot path — it
# is refreshed on-demand before risky edits via scripts/gitnexus-fresh.sh.
CMM_ENABLED="${AGENTIC_KNOWLEDGE_CMM_INDEX:-1}"
CMM_BIN="${AGENTIC_KNOWLEDGE_CMM_BIN:-codebase-memory-mcp}"
mkdir -p "$HOOK_LOG_DIR" 2>/dev/null || HOOK_LOG_DIR="/tmp"

COMMIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
COMMIT_MSG="$(git log -1 --pretty=%s 2>/dev/null || echo 'unknown commit')"
COMMIT_DATE="$(git log -1 --pretty=%ad --date=format:'%Y-%m-%d %H:%M' 2>/dev/null || date +'%Y-%m-%d %H:%M')"
MONTH_TAG="$(date +'%Y-%m')"

run_cmm() {
  if [[ "$CMM_ENABLED" == "0" || "$CMM_ENABLED" == "false" ]]; then
    echo "[post-commit] CMM index skipped: AGENTIC_KNOWLEDGE_CMM_INDEX=0"
    return 0
  fi
  if ! command -v "$CMM_BIN" >/dev/null 2>&1; then
    echo "[post-commit] CMM index skipped: '$CMM_BIN' not found (install codebase-memory-mcp)"
    return 0
  fi
  # git-aware incremental index of the working tree; self-contained, no native
  # embedding crashes, ~5s. Honors .cbmignore (excludes legacy_reference/ etc).
  "$CMM_BIN" cli index_repository "{\"repo_path\":\"$REPO_ROOT\"}" >/dev/null \
    && echo "[post-commit] CMM index updated" \
    || echo "[post-commit] CMM index failed (non-fatal)"
}

# Generic mkdir-based mutex with PID-stamped pidfile and stale-lock
# reclaim. Used by the semantic-vector-index step to keep multiple
# post-commit invocations (rapid commits, M2-x phase pushes) from
# racing each other.
#
# Args: $1=lock dir path, $2=human label used in skip/stale log lines.
acquire_lock() {
  local lock_dir="$1"
  local label="$2"
  local waited=0
  mkdir -p "$(dirname "$lock_dir")" 2>/dev/null || true
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if [[ -f "$lock_dir/pid" ]]; then
      local lock_pid
      lock_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        echo "[post-commit] Removing stale $label lock held by pid $lock_pid"
        rm -rf "$lock_dir"
        continue
      fi
    fi
    if (( waited >= LOCK_TIMEOUT_SECS )); then
      echo "[post-commit] $label skipped: lock wait timed out after ${LOCK_TIMEOUT_SECS}s"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s\n' "$$" > "$lock_dir/pid"
}

release_lock() {
  rm -rf "$1"
}

run_graphify() {
  if [[ ! -d graphify-out ]]; then
    echo "[post-commit] graphify skipped: graphify-out is not initialized"
    return 0
  fi
  if ! command -v graphify >/dev/null 2>&1; then
    echo "[post-commit] graphify skipped: graphify not found"
    return 0
  fi
  graphify update .
}

run_semantic_vector_index() {
  if [[ "$VECTOR_INDEX_ENABLED" == "0" || "$VECTOR_INDEX_ENABLED" == "false" ]]; then
    echo "[post-commit] Semantic vector index skipped: AGENTIC_KNOWLEDGE_VECTOR_INDEX=0"
    return 0
  fi
  if [[ ! -f graphify-out/graph.json ]]; then
    echo "[post-commit] Semantic vector index skipped: graphify-out/graph.json not found"
    return 0
  fi
  if [[ ! -f scripts/build-semantic-vector-index.mjs ]]; then
    echo "[post-commit] Semantic vector index skipped: builder script not found"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "[post-commit] Semantic vector index skipped: node not found"
    return 0
  fi
  # docs-only: the vector index now serves natural-language doc/decision recall
  # (incl. Obsidian vault, which lives outside the repo). Code recall is served
  # by CMM. Both default on; override with AGENTIC_KNOWLEDGE_DOCS_ONLY=0 /
  # AGENTIC_KNOWLEDGE_OBSIDIAN=0.
  local docs_flag="" obs_flag=""
  [[ "${AGENTIC_KNOWLEDGE_DOCS_ONLY:-1}" != "0" ]] && docs_flag="--docs-only"
  [[ "${AGENTIC_KNOWLEDGE_OBSIDIAN:-1}" != "0" ]] && obs_flag="--obsidian"
  node scripts/build-semantic-vector-index.mjs \
    --provider "$VECTOR_PROVIDER" \
    --model "$VECTOR_MODEL" \
    --project "$PROJECT_NAME" \
    $docs_flag $obs_flag
}

run_semantic_vector_index_locked() {
  if [[ "$VECTOR_INDEX_ENABLED" == "0" || "$VECTOR_INDEX_ENABLED" == "false" ]]; then
    echo "[post-commit] Semantic vector index skipped: AGENTIC_KNOWLEDGE_VECTOR_INDEX=0"
    return 0
  fi
  acquire_lock "semantic-vector-index/post-commit.lock" "Semantic vector index" || return 0
  run_semantic_vector_index
  release_lock "semantic-vector-index/post-commit.lock"
}

write_obsidian_log() {
  local vault_root project_dir log_dir log_file
  if [[ -n "${OBSIDIAN_PROJECT_DIR:-}" ]]; then
    project_dir="$OBSIDIAN_PROJECT_DIR"
  else
    if [[ -n "${OBSIDIAN_VAULT:-}" ]]; then
      vault_root="$OBSIDIAN_VAULT"
    elif [[ -d "$HOME/Documents/Obsidian Vault" ]]; then
      vault_root="$HOME/Documents/Obsidian Vault"
    else
      vault_root="$HOME/Obsidian Vault"
    fi
    project_dir="$vault_root/$PROJECT_NAME"
  fi

  local project_parent
  project_parent="$(dirname "$project_dir")"
  if [[ ! -d "$project_parent" ]]; then
    echo "[post-commit] Obsidian skipped: vault parent not found at $project_parent"
    return 0
  fi

  log_dir="$project_dir/Development Logs"
  log_file="$log_dir/${MONTH_TAG} commit log.md"
  mkdir -p "$log_dir" || return 0

  if [[ ! -f "$log_file" ]]; then
    cat > "$log_file" <<EOF
# ${MONTH_TAG} commit log

Generated by \`scripts/post-commit-hook.sh\`.

Tags: #commit-log #${MONTH_TAG}

---

EOF
  fi

  if grep -Fq "\`${COMMIT_HASH}\`" "$log_file"; then
    echo "[post-commit] Obsidian already logged: $COMMIT_HASH"
    return 0
  fi

  printf -- "- \`%s\` (%s) - %s\n" "$COMMIT_HASH" "$COMMIT_DATE" "$COMMIT_MSG" >> "$log_file"
  echo "[post-commit] Obsidian logged: $log_file"
}

if [[ "$ASYNC_MODE" == "0" || "$ASYNC_MODE" == "false" ]]; then
  run_cmm > "$HOOK_LOG_DIR/cmm-post-commit.log" 2>&1 || true
else
  (run_cmm > "$HOOK_LOG_DIR/cmm-post-commit.log" 2>&1 &)
  echo "[post-commit] CMM index running in background"
fi

run_graphify > "$HOOK_LOG_DIR/graphify-post-commit.log" 2>&1 || true
if [[ "$ASYNC_MODE" == "0" || "$ASYNC_MODE" == "false" ]]; then
  run_semantic_vector_index_locked > "$HOOK_LOG_DIR/semantic-vector-index-post-commit.log" 2>&1 || true
else
  (run_semantic_vector_index_locked > "$HOOK_LOG_DIR/semantic-vector-index-post-commit.log" 2>&1 &)
  echo "[post-commit] Semantic vector index running in background"
fi
write_obsidian_log || true
