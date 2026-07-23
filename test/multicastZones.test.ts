import {
  MZ_COUNT, MZ_CODEC_PAIRS, normalizeZones, validateZones,
  serializeZones, classifyZonesProbe, parseZoneIdFromMessage,
} from '@shared/multicastZones'
import type { MulticastZone } from '@shared/types'

const z = (p: Partial<MulticastZone>): MulticastZone => ({
  zone_id: 1, multicast_address: '', multicast_port: 0, priority: 0,
  enabled: false, audio_codec: '', ...p,
})

describe('常數', () => {
  it('MZ_COUNT=16、codec 為 G.711U/G.722', () => {
    expect(MZ_COUNT).toBe(16)
    expect(MZ_CODEC_PAIRS.map(([v]) => v)).toEqual(['G.711U', 'G.722'])
  })
})

describe('normalizeZones', () => {
  it('null → 16 筆停用佔位列（zone_id 1..16）', () => {
    const out = normalizeZones(null)
    expect(out).toHaveLength(16)
    expect(out[0]).toEqual(z({ zone_id: 1 }))
    expect(out[15].zone_id).toBe(16)
    expect(out.every((r) => !r.enabled)).toBe(true)
  })
  it('少於 16 筆 + 亂序 → 依 zone_id 補位到 16', () => {
    const out = normalizeZones([z({ zone_id: 3, enabled: true, priority: 2 })])
    expect(out).toHaveLength(16)
    expect(out[2]).toMatchObject({ zone_id: 3, enabled: true, priority: 2 })
    expect(out[0]).toEqual(z({ zone_id: 1 }))
  })
  it('過濾髒資料：null entry / zone_id==null / 超界 zone_id 不汙染', () => {
    const raw = [null, z({ zone_id: 2, enabled: true }), { zone_id: null } as unknown as MulticastZone,
                 z({ zone_id: 99 })] as (MulticastZone | null)[]
    const out = normalizeZones(raw as MulticastZone[])
    expect(out).toHaveLength(16)
    expect(out[1]).toMatchObject({ zone_id: 2, enabled: true })
    expect(out[0]).toEqual(z({ zone_id: 1 })) // 未被 null/99 汙染
  })
  it('port/priority 字串化輸入 → 強制成 number（型別維持 number）', () => {
    const raw = [{ zone_id: 1, multicast_address: '239.1.1.1', multicast_port: '2000',
                   priority: '3', enabled: true, audio_codec: 'G.722' }] as unknown as MulticastZone[]
    expect(normalizeZones(raw)[0]).toMatchObject({ multicast_port: 2000, priority: 3 })
  })
})

describe('validateZones', () => {
  const good = z({ zone_id: 1, multicast_address: '239.1.1.1', multicast_port: 2000, priority: 1, enabled: true, audio_codec: 'G.722' })
  it('合法啟用列 → 無錯', () => {
    expect(validateZones([good, ...Array.from({ length: 15 }, (_, i) => z({ zone_id: i + 2 }))])).toEqual([])
  })
  it('佔位列（全空停用）→ 略過驗證', () => {
    expect(validateZones([z({ zone_id: 1 })])).toEqual([])
  })
  it('位址邊界：223/240 擋、224/239 過', () => {
    expect(validateZones([z({ ...good, multicast_address: '223.1.1.1' })])).toHaveLength(1)
    expect(validateZones([z({ ...good, multicast_address: '240.1.1.1' })])).toHaveLength(1)
    expect(validateZones([z({ ...good, multicast_address: '224.1.1.1' })])).toEqual([])
    expect(validateZones([z({ ...good, multicast_address: '239.255.255.255' })])).toEqual([])
  })
  it('非法 dotted-quad 擋（超 255 / 少段 / 非數字）', () => {
    for (const a of ['224.500.1.1', '224.256.1.1', '224.1.1', '224.1.1.1.1', 'abc', '239']) {
      expect(validateZones([z({ ...good, multicast_address: a })])).toHaveLength(1)
    }
  })
  it('埠邊界 1023/65536 擋、1024/65535 過', () => {
    expect(validateZones([z({ ...good, multicast_port: 1023 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, multicast_port: 65536 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, multicast_port: 1024 })])).toEqual([])
  })
  it('優先權邊界 0/17 擋、1/16 過、非整數擋', () => {
    expect(validateZones([z({ ...good, priority: 0 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, priority: 17 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, priority: 1.5 })])).toHaveLength(1)
    expect(validateZones([z({ ...good, priority: 16 })])).toEqual([])
  })
  it('touched 但停用（有值）仍完整驗證', () => {
    expect(validateZones([z({ zone_id: 1, multicast_address: '1.2.3.4', enabled: false })])).toHaveLength(1)
  })
  it('codec 必選：touched 列缺 codec → 擋', () => {
    expect(validateZones([z({ ...good, audio_codec: '' })])).toHaveLength(1)
  })
  it('啟用區優先權全域唯一：重複 → 擋（停用區不計）', () => {
    const a = z({ zone_id: 1, multicast_address: '239.1.1.1', multicast_port: 2000, priority: 5, enabled: true, audio_codec: 'G.722' })
    const b = z({ zone_id: 2, multicast_address: '239.1.1.2', multicast_port: 2001, priority: 5, enabled: true, audio_codec: 'G.722' })
    const c = z({ zone_id: 3, multicast_address: '239.1.1.3', multicast_port: 2002, priority: 5, enabled: false, audio_codec: 'G.722' })
    const errs = validateZones([a, b, c])
    expect(errs.some((e) => e.zone_id === 2)).toBe(true)
    expect(errs.some((e) => e.zone_id === 3)).toBe(false)
  })
})

describe('serializeZones', () => {
  it('套預設值：空 codec→G.722、空 port/prio→0', () => {
    expect(serializeZones([z({ zone_id: 1 })])[0]).toMatchObject({ multicast_port: 0, priority: 0, audio_codec: 'G.722' })
  })
})

describe('classifyZonesProbe', () => {
  it('成功含非空 zones → zones', () => {
    expect(classifyZonesProbe({ ok: true, zones: [{ zone_id: 1 }] })).toBe('zones')
  })
  it('成功但 zones 空/缺 → unsupported', () => {
    expect(classifyZonesProbe({ ok: true, zones: [] })).toBe('unsupported')
    expect(classifyZonesProbe({ ok: true, zones: undefined })).toBe('unsupported')
  })
  it('403/404（路由確定不支援＝舊韌體）→ unsupported', () => {
    // 真機實測：新版工廠 https 韌體(.72)未知 GET 路由回 403；我方 mzweb 未知路由回 404。
    expect(classifyZonesProbe({ ok: false, httpStatus: 404 })).toBe('unsupported')
    expect(classifyZonesProbe({ ok: false, httpStatus: 403 })).toBe('unsupported')
  })
  it('401/5xx（非路由不支援：auth／mzrelay3 暫時 503 等，capable 設備仍可能）→ error', () => {
    expect(classifyZonesProbe({ ok: false, httpStatus: 500 })).toBe('error')
    expect(classifyZonesProbe({ ok: false, httpStatus: 503 })).toBe('error')
    expect(classifyZonesProbe({ ok: false, httpStatus: 401 })).toBe('error')
  })
  it('錯誤無回應（逾時/傳輸）→ error', () => {
    expect(classifyZonesProbe({ ok: false })).toBe('error')
  })
})

describe('parseZoneIdFromMessage', () => {
  it('從 E001 message 萃取 zone id', () => {
    expect(parseZoneIdFromMessage('zone_id 7: multicast_address invalid (224-239 required)')).toBe(7)
  })
  it('無法萃取 → undefined', () => {
    expect(parseZoneIdFromMessage('unexpected error')).toBeUndefined()
    expect(parseZoneIdFromMessage('')).toBeUndefined()
  })
})
