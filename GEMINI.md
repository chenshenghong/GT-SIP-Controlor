<!-- agentic-knowledge:start -->
## Agentic Knowledge Setup

This repo is wired for codebase-memory-mcp (CMM, code engine), GitNexus
(on-demand edit-safety), graphify, LanceDB doc retrieval, and Obsidian memory.

**知識系統分層（按資料型態切 4 個鬆耦合引擎）：**
- **程式碼導航/搜尋 → CMM**（`codebase-memory-mcp` MCP，每 commit ~0.5s 增量；`.cbmignore` 排噪音）。每日程式碼主引擎。
- **改碼安全（impact 風險/PDG taint/rename/detect_changes vs base）→ GitNexus**，但**改碼/rename/PR 前先 `bash scripts/gitnexus-fresh.sh`**（已退出 commit 熱路徑、不自動新鮮）。
- **文件/決策/根因召回 → broker（docs-only LanceDB ＋ Obsidian vault，含中文）**，每次提問自動注入。
- **跨域/多模態 → graphify**；人類記憶 → Obsidian。CMM 不吃文件/中文、無 rename、無 risk 分級。

- CMM (code graph): `codebase-memory-mcp` MCP; per-machine bootstrap `bash scripts/install-cmm.sh`; excludes via `.cbmignore`
- GitNexus MCP — **on-demand**: `bash scripts/gitnexus-fresh.sh` (taint: `AGENTIC_KNOWLEDGE_PDG=1`)
- graphify graph: `graphify-out/`
- doc vector index: `semantic-vector-index/lancedb` (docs-only + Obsidian); rebuild `node scripts/build-semantic-vector-index.mjs --docs-only --obsidian`
- task context broker: `node scripts/agentic-knowledge-context.mjs "<task>"`
- post-commit hook: `scripts/post-commit-hook.sh` (CMM incremental + graphify + docs-only vector + Obsidian log; GitNexus NOT in hook)

### Retrieval Protocol

At task start, consume the broker (auto-injected for Claude via UserPromptSubmit):

```bash
node scripts/agentic-knowledge-context.mjs "<task summary>" --limit "${AGENTIC_KNOWLEDGE_CONTEXT_LIMIT:-5}"
```

The broker returns doc/decision/root-cause matches (repo docs + Obsidian vault, incl. Chinese) — not code. Then: code structure/search → **CMM**; edit-safety (impact/taint/rename/detect_changes) → **GitNexus** after `bash scripts/gitnexus-fresh.sh`; cross-module relations → **graphify**. Verify exact behavior in source/tests before editing.
<!-- agentic-knowledge:end -->
