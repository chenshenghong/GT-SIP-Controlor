#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANCEDB_VERSION="${AGENTIC_KNOWLEDGE_LANCEDB_VERSION:-0.27.2}"

if [[ "${AGENTIC_KNOWLEDGE_SKIP_VECTOR_DEPS:-0}" == "1" ]]; then
  echo "Semantic vector dependency install skipped: AGENTIC_KNOWLEDGE_SKIP_VECTOR_DEPS=1"
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  if node - "$SCRIPT_DIR" <<'NODE' >/dev/null 2>&1
const { createRequire } = require('node:module');
const { join } = require('node:path');
const scriptDir = process.argv[2];
const requireFromScripts = createRequire(join(scriptDir, 'semantic-vector-lib.mjs'));
requireFromScripts.resolve('@lancedb/lancedb');
NODE
  then
    echo "LanceDB dependency already available"
    exit 0
  fi
fi

if [[ -f "$SCRIPT_DIR/node_modules/@lancedb/lancedb/package.json" ]]; then
  echo "LanceDB dependency already installed in scripts/node_modules"
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found; cannot install @lancedb/lancedb for semantic vector search" >&2
  exit 1
fi

npm install \
  --prefix "$SCRIPT_DIR" \
  --no-save \
  --package-lock=false \
  --no-audit \
  --no-fund \
  "@lancedb/lancedb@${LANCEDB_VERSION}"

echo "LanceDB dependency installed in scripts/node_modules"
