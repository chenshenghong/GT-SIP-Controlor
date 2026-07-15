import re, sys

MARKER = "<!-- ak-gitnexus-fresh-contract -->"
BANNER = (
    MARKER + "\n"
    "> ⚠️ **本 repo 契約**：刷新 GitNexus index 一律 `bash scripts/gitnexus-fresh.sh`"
    "（或改碼前由 PreToolUse gate 自動）——它用 `.mcp.json` 釘的 **exact** 版本寫 index，"
    "避免 CLI-vs-MCP storage-version skew。**勿裸跑** `npx gitnexus analyze` / "
    "`node .gitnexus/run.cjs analyze` / `gitnexus@latest`（unpinned 會寫出 MCP 讀不了的"
    "格式，弄壞 impact/rename/detect_changes）。下方為 GitNexus 通用 CLI 參考。\n"
)
# stale-hint 行（"... run `<cmd>` ..."）的裸指令 → 對齊版本 fresh.sh。
# 只 match "run `cmd`"，故不碰 gitnexus-cli 的 "(Re)generate it with `cmd`" 或 code-block 範例。
STALE = re.compile(r'run `(?:npx gitnexus analyze|node \.gitnexus/run\.cjs analyze)`')

def patch(path):
    t = open(path, encoding="utf-8").read()
    orig = t
    # 1) 契約 banner（frontmatter 後，idempotent）
    if MARKER not in t:
        m = re.match(r'^(---\n.*?\n---\n)', t, re.S)
        ins = "\n" + BANNER
        t = (t[:m.end()] + ins + t[m.end():]) if m else (BANNER + "\n" + t)
    # 2) stale-hint 裸指令替換（idempotent：替換後不再 match）
    t = STALE.sub('run `bash scripts/gitnexus-fresh.sh`', t)
    if t != orig:
        open(path, "w", encoding="utf-8").write(t)
        return True
    return False

if __name__ == "__main__":
    n = 0
    for p in sys.argv[1:]:
        if patch(p):
            n += 1
            print(f"  patched {p}")
    print(f"[patch-gitnexus-skill] {n} file(s) changed")
