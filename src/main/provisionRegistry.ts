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
 */
export async function saveRegistry(filePath: string, data: ProvisionRegistryFile): Promise<void> {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`)
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, filePath)
}
