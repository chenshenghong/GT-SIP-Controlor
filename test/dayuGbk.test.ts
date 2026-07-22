// test/dayuGbk.test.ts
import { gbkDecode, gbkFormEncode } from '../src/main/dayu/gbk'
import * as iconv from 'iconv-lite'

describe('gbk 編解碼', () => {
  it('gbkDecode 正確解 GBK bytes（ASCII 相容）', () => {
    expect(gbkDecode(iconv.encode('大廳喇叭 volume=7', 'gbk'))).toBe('大廳喇叭 volume=7')
  })

  it('gbkFormEncode：ASCII 欄位與標準 urlencode 一致（空白=+、unreserved 原樣）', () => {
    const body = gbkFormEncode([['DefaultSubmit', 'Apply'], ['a b', 'c*d-e_f.g']]).toString('latin1')
    expect(body).toBe('DefaultSubmit=Apply&a+b=c*d-e_f.g')
  })

  it('gbkFormEncode：非 ASCII 值以 GBK bytes percent-encode（不是 UTF-8）', () => {
    // '大' 的 GBK 編碼是 0xB4 0xF3（UTF-8 會是 %E5%A4%A7 — 那就是把設備名改壞的 bug）
    const body = gbkFormEncode([['name', '大']]).toString('latin1')
    expect(body).toBe('name=%B4%F3')
  })

  it('round-trip：encode 後逐 byte 還原可 gbkDecode 回原文', () => {
    const body = gbkFormEncode([['n', '大廳喇叭']]).toString('latin1')
    const raw = body.split('=')[1].replace(/\+/g, ' ')
      .replace(/%([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    expect(gbkDecode(Buffer.from(raw, 'latin1'))).toBe('大廳喇叭')
  })
})
