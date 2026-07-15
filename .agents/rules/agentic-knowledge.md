# Agentic Knowledge Retrieval

知識系統分層（按資料型態切）：
- 程式碼導航/搜尋 → **CMM**（codebase-memory-mcp MCP）。每日程式碼主引擎。
- 改碼安全（impact 風險/taint/rename/detect_changes vs base）→ **GitNexus**，改碼/rename/PR 前先 `bash scripts/gitnexus-fresh.sh`（不在 commit hook、不自動新鮮）。
- 文件/決策/根因召回 → broker（docs-only + Obsidian vault，含中文），task 開始時查：

```bash
node scripts/agentic-knowledge-context.mjs "<task summary>" --limit "${AGENTIC_KNOWLEDGE_CONTEXT_LIMIT:-5}"
```

- 跨域關係 → graphify。Verify exact behavior in source/tests before editing. CMM 不吃文件/中文、無 rename、無 risk 分級。

For LLM Wiki: read immutable material from `raw/`, write synthesis under `wiki/`, run `node scripts/lint-llm-wiki.mjs --strict` before treating wiki notes as clean.
