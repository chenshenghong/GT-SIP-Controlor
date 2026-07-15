<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **GT-SIP-Controlor** (527 symbols, 974 relationships, 43 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/GT-SIP-Controlor/context` | Codebase overview, check index freshness |
| `gitnexus://repo/GT-SIP-Controlor/clusters` | All functional areas |
| `gitnexus://repo/GT-SIP-Controlor/processes` | All execution flows |
| `gitnexus://repo/GT-SIP-Controlor/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

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
