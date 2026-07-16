import { promises as fs } from 'fs'
import * as path from 'path'
import type { ProvisionRegistryFile } from '@shared/types'

const EMPTY: ProvisionRegistryFile = { config: null, records: [] }

/** ISO 時間戳的 compact 形式（無 Date.now 以外相依），供備份檔命名。 */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
}

/**
 * 讀登記表。檔案不存在或內容壞掉都回空表；壞檔會先改名備份（.corrupt-<ts>）
 * 以免下次 save 覆蓋掉可能可搶救的資料。
 */
export async function loadRegistry(filePath: string): Promise<ProvisionRegistryFile> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch {
    return { ...EMPTY }
  }
  try {
    const parsed = JSON.parse(raw) as ProvisionRegistryFile
    if (!parsed || !Array.isArray(parsed.records)) throw new Error('shape')
    return parsed
  } catch {
    try {
      await fs.rename(filePath, `${filePath}.corrupt-${stamp(Date.now())}`)
    } catch {
      /* 備份失敗不阻斷 */
    }
    return { ...EMPTY }
  }
}

/**
 * 原子寫入：先寫同目錄的 temp 檔再 rename（同 volume 才保證原子）。
 * 失敗會 throw，讓呼叫端進入降級模式。
 *
 * 多台設備幾乎同時完成時會有多個 persist() 並發，故：
 * (1) 所有寫入用一條 promise 鏈序列化，避免並發搶檔；
 * (2) temp 檔名帶單調遞增序號（非只有 pid），即使並發也各用各的來源檔，
 *     不會發生「A 的 rename 把 temp 移走、B 的 rename 找不到來源(ENOENT)」。
 * 這修掉了實測 2026-07-16 .184 的「登記表寫入失敗→降級 banner」誤報。
 */
let writeChain: Promise<void> = Promise.resolve()
let tmpCounter = 0

async function writeAtomic(filePath: string, data: ProvisionRegistryFile): Promise<void> {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${++tmpCounter}`
  )
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tmp, filePath)
  } catch (e) {
    try { await fs.unlink(tmp) } catch { /* 殘留 temp 清不掉不阻斷 */ }
    throw e
  }
}

export function saveRegistry(filePath: string, data: ProvisionRegistryFile): Promise<void> {
  const run = writeChain.then(() => writeAtomic(filePath, data))
  // 讓鏈不因單次失敗而中斷（下一次寫入仍能排進來）；錯誤照樣 propagate 給本次呼叫端
  writeChain = run.catch(() => {})
  return run
}
