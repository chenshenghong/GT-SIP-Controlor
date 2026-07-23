import type { MulticastZone } from './types'

export const MZ_COUNT = 16
export const MZ_CODEC_PAIRS: readonly [string, string][] = [
  ['G.711U', 'G.711 µ-law'],
  ['G.722', 'G.722'],
]
const MZ_CODECS: readonly string[] = MZ_CODEC_PAIRS.map(([v]) => v)

function emptyZone(id: number): MulticastZone {
  return { zone_id: id, multicast_address: '', multicast_port: 0, priority: 0, enabled: false, audio_codec: '' }
}

/** 補滿至 16 筆；先過濾髒資料（null / zone_id 缺或超界），缺漏 zone_id 補停用佔位列。 */
export function normalizeZones(raw: MulticastZone[] | null): MulticastZone[] {
  const byId = new Map<number, MulticastZone>()
  if (Array.isArray(raw)) {
    for (const z of raw) {
      const id = z == null ? null : Number(z.zone_id)
      if (id == null || !Number.isInteger(id) || id < 1 || id > MZ_COUNT) continue
      byId.set(id, {
        zone_id: id,
        multicast_address: z.multicast_address ?? '',
        multicast_port: Number(z.multicast_port) || 0,
        priority: Number(z.priority) || 0,
        enabled: !!z.enabled,
        audio_codec: z.audio_codec ?? '',
      })
    }
  }
  const out: MulticastZone[] = []
  for (let i = 1; i <= MZ_COUNT; i++) out.push(byId.get(i) ?? emptyZone(i))
  return out
}

function isValidMulticastAddr(addr: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (!m) return false
  const octs = [m[1], m[2], m[3], m[4]].map((s) => Number(s))
  if (octs.some((o) => o < 0 || o > 255)) return false
  return octs[0] >= 224 && octs[0] <= 239
}

function isTouched(z: MulticastZone): boolean {
  return z.enabled || !!z.multicast_address || !!z.multicast_port || !!z.priority || !!z.audio_codec
}

/** 回全部錯誤（每列至多一則）；空陣列＝通過。 */
export function validateZones(zones: MulticastZone[]): { zone_id: number; message: string }[] {
  const errors: { zone_id: number; message: string }[] = []
  for (const z of zones) {
    if (!isTouched(z)) continue
    if (!isValidMulticastAddr(z.multicast_address)) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 組播位址錯誤：須為 224.x.x.x – 239.x.x.x` })
      continue
    }
    if (!(Number.isInteger(z.multicast_port) && z.multicast_port >= 1024 && z.multicast_port <= 65535)) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 埠錯誤：須介於 1024 – 65535` })
      continue
    }
    if (!(Number.isInteger(z.priority) && z.priority >= 1 && z.priority <= MZ_COUNT)) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 優先權錯誤：須介於 1 – ${MZ_COUNT} 的整數` })
      continue
    }
    if (!MZ_CODECS.includes(z.audio_codec)) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 未選音頻編碼` })
      continue
    }
  }
  // 啟用區優先權全域唯一（已有其他錯誤的列不再疊加）
  const seen = new Map<number, number>()
  for (const z of zones) {
    if (!z.enabled) continue
    if (errors.some((e) => e.zone_id === z.zone_id)) continue
    const prev = seen.get(z.priority)
    if (prev != null) {
      errors.push({ zone_id: z.zone_id, message: `Zone ${z.zone_id} 優先權 ${z.priority} 與 Zone ${prev} 重複（啟用區須全域唯一）` })
    } else {
      seen.set(z.priority, z.zone_id)
    }
  }
  return errors
}

/** 套送出預設值（對齊 device-web）：port||0、priority||0、codec||"G.722"。 */
export function serializeZones(zones: MulticastZone[]): MulticastZone[] {
  return zones.map((z) => ({
    zone_id: z.zone_id,
    multicast_address: z.multicast_address,
    multicast_port: z.multicast_port || 0,
    priority: z.priority || 0,
    enabled: z.enabled,
    audio_codec: z.audio_codec || 'G.722',
  }))
}

/** 能力偵測判別：成功含非空 zones=zones；設備有回應但無 zones=unsupported；404=舊韌體=unsupported；其餘（401/403/5xx/逾時/無回應）=error。 */
export function classifyZonesProbe(r: { ok?: boolean; zones?: unknown; httpStatus?: number }): 'zones' | 'unsupported' | 'error' {
  if (r.ok) return Array.isArray(r.zones) && r.zones.length > 0 ? 'zones' : 'unsupported'
  // 只有「路由不存在」(404) 才是確定的舊韌體 → 單槽卡；401/403/5xx/逾時/傳輸失敗一律 'error'
  // （安全占位、不暴露危險單槽寫入路徑、可重新偵測）——防 mzrelay3 暫時性 503 誤判斷鏈
  if (r.httpStatus === 404) return 'unsupported'
  return 'error'
}

/** 從 E001 message（"zone_id N: ..."）萃取 zone id；失敗回 undefined。 */
export function parseZoneIdFromMessage(message: string): number | undefined {
  const m = /zone_id\s+(\d+)/i.exec(message || '')
  return m ? Number(m[1]) : undefined
}
