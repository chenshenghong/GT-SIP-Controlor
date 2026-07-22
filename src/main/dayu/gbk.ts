// ============================================
// DAYU-OT300 GBK 編解碼（真機釘死：全協定 GBK）
// 寫入端絕不可用 URLSearchParams/encodeURIComponent（UTF-8）——
// 非 ASCII 欄位值（中文設備名等）會在完整表單回帶時被悄悄改壞
// （「大廳喇叭」→「澶у怀鍠囧彮」）。fail-closed：一律 GBK percent-encode。
// ============================================
import * as iconv from 'iconv-lite'

export function gbkDecode(buf: Buffer): string {
  return iconv.decode(buf, 'gbk')
}

const UNRESERVED = /[A-Za-z0-9\-_.*]/

function encodeComponent(s: string): string {
  const bytes = iconv.encode(s, 'gbk')
  let out = ''
  for (const b of bytes) {
    if (b === 0x20) out += '+'
    else if (b < 0x80 && UNRESERVED.test(String.fromCharCode(b))) out += String.fromCharCode(b)
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/** 依序編碼表單欄位（順序保留 — 表單回帶按頁面原始順序送出） */
export function gbkFormEncode(fields: Array<[string, string]>): Buffer {
  return Buffer.from(
    fields.map(([k, v]) => `${encodeComponent(k)}=${encodeComponent(v)}`).join('&'),
    'latin1'
  )
}
