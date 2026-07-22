// ============================================
// Rapid Logic 表單保真 parser / rebuilder（純函式，無 IO）。
// 真機裁決的完整回帶 checklist（漏一項就是靜默關功能／改壞設定）：
//   收：input(text/hidden/password) ＋ checked 的 checkbox/radio
//       ＋ select 的 selected option（無 selected 取第一個 — 瀏覽器語意）
//       ＋ textarea
//   略過：按鈕型 input（submit/button/reset/image）；DefaultSubmit=Apply 顯式補
// checkbox 狀態＝靜態 inline `checked` 屬性（真機驗證非 JS 注入，可信）。
// ============================================
import * as cheerio from 'cheerio'

export interface FormField {
  name: string
  value: string
}

const BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'image'])

export function parseFormFields(html: string): FormField[] {
  const $ = cheerio.load(html)
  const fields: FormField[] = []
  // Rapid Logic 設定頁單一表單；鎖定第一個 form 避免跨表單合併（多 form 頁面誤把別的表單欄位一起回帶）。
  $('form').first().find('input[name], select[name], textarea[name]').each((_i, el) => {
    const $el = $(el)
    const name = $el.attr('name') as string
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const type = ($el.attr('type') ?? 'text').toLowerCase()
      if (BUTTON_TYPES.has(type)) return
      if (type === 'checkbox' || type === 'radio') {
        if ($el.attr('checked') !== undefined) fields.push({ name, value: $el.attr('value') ?? 'ON' })
        return
      }
      fields.push({ name, value: $el.attr('value') ?? '' })
      return
    }
    if (tag === 'select') {
      const selected = $el.find('option[selected]').first()
      const opt = selected.length ? selected : $el.find('option').first()
      if (opt.length) fields.push({ name, value: opt.attr('value') ?? opt.text() })
      return
    }
    fields.push({ name, value: $el.text() }) // textarea
  })
  return fields
}

/**
 * 全表單回帶：頁面欄位按原順序、套 overrides；頁面上缺席的 override
 * （如強制勾選但當前未勾的 checkbox）補在尾端；最後顯式補 DefaultSubmit=Apply。
 */
export function buildSubmitFields(
  fields: FormField[], overrides: Record<string, string>
): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const pending = new Map(Object.entries(overrides))
  for (const f of fields) {
    if (pending.has(f.name)) {
      out.push([f.name, pending.get(f.name)!])
      pending.delete(f.name)
    } else {
      out.push([f.name, f.value])
    }
  }
  for (const [k, v] of pending) out.push([k, v])
  out.push(['DefaultSubmit', 'Apply'])
  return out
}
