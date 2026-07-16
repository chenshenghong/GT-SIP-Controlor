import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadRegistry, saveRegistry } from '../src/main/provisionRegistry'
import type { ProvisionRegistryFile } from '@shared/types'

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prov-reg-'))
  return path.join(dir, 'provision-registry.json')
}

const sample: ProvisionRegistryFile = {
  config: null,
  records: [{ mac: 'AA', assignedIp: '10.0.0.1', assignedExt: 8001, status: 'provisioned', updatedAt: '2026-01-01T00:00:00Z' }],
}

describe('provisionRegistry', () => {
  it('save 後 load 得回原資料', async () => {
    const f = await tmpFile()
    await saveRegistry(f, sample)
    expect(await loadRegistry(f)).toEqual(sample)
  })

  it('檔案不存在 → 空表', async () => {
    const f = await tmpFile()
    expect(await loadRegistry(f)).toEqual({ config: null, records: [] })
  })

  it('壞檔 → 空表且原檔被改名備份', async () => {
    const f = await tmpFile()
    await fs.writeFile(f, '{ this is not json', 'utf-8')
    expect(await loadRegistry(f)).toEqual({ config: null, records: [] })
    const dir = path.dirname(f)
    const files = await fs.readdir(dir)
    expect(files.some((n) => n.includes('.corrupt-'))).toBe(true)
  })

  // 回歸（實測 .184 降級 banner）：多台設備同時完成 → 並發 persist，
  // 不可因搶同一 temp 檔而拋錯；最終檔案須為有效 JSON。
  it('並發寫入不 race：20 次同時 save 全部成功、檔案有效', async () => {
    const f = await tmpFile()
    const writes = Array.from({ length: 20 }, (_, i) =>
      saveRegistry(f, { config: null, records: [
        { mac: `M${i}`, assignedIp: `10.0.0.${i}`, assignedExt: 8000 + i, status: 'provisioned', updatedAt: '' }] }))
    await expect(Promise.all(writes)).resolves.toBeDefined() // 無任何一次 reject
    const loaded = await loadRegistry(f)
    expect(Array.isArray(loaded.records)).toBe(true)
    expect(loaded.records.length).toBe(1) // 每次寫整份，最後一次勝出
    // 目錄不應殘留 .tmp- 檔
    const leftover = (await fs.readdir(path.dirname(f))).filter((n) => n.includes('.tmp-'))
    expect(leftover).toEqual([])
  })
})
