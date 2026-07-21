import { parseFormFields, buildSubmitFields } from '../src/main/dayu/dayuForm'

// 結構仿真機 media.htm / lines.htm（欄位型態涵蓋 checklist 全項）
const PAGE =
  '<html><body><form name="mediaForm" action="media.htm">' +
  '<input type="text" name="DSP_HandfreeVolume_RW" value="7" maxlength="1">' +
  '<input type="hidden" name="DSP_CodecSets_RW" value="G722,PCMU,PCMA,G729">' +
  '<input type="hidden" name="ReturnPage" value="/media.htm">' +
  '<input type="password" name="SEC_Pin_RW" value="p1">' +
  '<input id="reg" type="checkbox" name="SIP_EnableSipReg_RW" value="ON" CHECKED>' +
  '<input type="checkbox" name="MEDIA_EnableSidetone_RW" value="ON">' +
  '<input type="radio" name="MEDIA_Mode_RW" value="0"><input type="radio" name="MEDIA_Mode_RW" value="1" checked>' +
  '<select name="MEDIA_SampleRate_RW"><option value="8000">8k</option><option value="16000" selected>16k</option></select>' +
  '<select name="MEDIA_NoSelect_RW"><option value="a">a</option><option value="b">b</option></select>' +
  '<textarea name="MEDIA_Note_RW">hello</textarea>' +
  '<input type="submit" name="DefaultSubmit" value="Apply">' +
  '<input type="button" name="BtnX" value="x"><input type="reset" name="BtnR" value="r">' +
  '</form></body></html>'

describe('parseFormFields（表單保真 checklist）', () => {
  const fields = parseFormFields(PAGE)
  const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]))

  it('text/hidden/password 帶原值', () => {
    expect(byName['DSP_HandfreeVolume_RW']).toBe('7')
    expect(byName['DSP_CodecSets_RW']).toBe('G722,PCMU,PCMA,G729')
    expect(byName['ReturnPage']).toBe('/media.htm')
    expect(byName['SEC_Pin_RW']).toBe('p1')
  })

  it('勾選的 checkbox 收錄（含大寫 CHECKED）、未勾選的不收', () => {
    expect(byName['SIP_EnableSipReg_RW']).toBe('ON')
    expect('MEDIA_EnableSidetone_RW' in byName).toBe(false)
  })

  it('radio 只收 checked 的那個', () => {
    expect(byName['MEDIA_Mode_RW']).toBe('1')
    expect(fields.filter((f) => f.name === 'MEDIA_Mode_RW')).toHaveLength(1)
  })

  it('select 收 selected option；無 selected 時收第一個（瀏覽器語意）', () => {
    expect(byName['MEDIA_SampleRate_RW']).toBe('16000')
    expect(byName['MEDIA_NoSelect_RW']).toBe('a')
  })

  it('textarea 收內文；按鈕型 input（submit/button/reset）一律略過', () => {
    expect(byName['MEDIA_Note_RW']).toBe('hello')
    expect('DefaultSubmit' in byName).toBe(false)
    expect('BtnX' in byName).toBe(false)
    expect('BtnR' in byName).toBe(false)
  })
})

describe('多 form 頁面（防跨表單合併）', () => {
  const PAGE_MULTI_FORM =
    PAGE +
    '<form name="otherForm" action="other.htm">' +
    '<input type="text" name="OTHER_FieldX" value="junk">' +
    '</form>'

  it('只解析第一個 form，不含第二個 form 的欄位，原有欄位照舊', () => {
    const fields = parseFormFields(PAGE_MULTI_FORM)
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]))
    expect('OTHER_FieldX' in byName).toBe(false)
    expect(byName['DSP_HandfreeVolume_RW']).toBe('7')
    expect(byName['SIP_EnableSipReg_RW']).toBe('ON')
  })
})

describe('buildSubmitFields', () => {
  it('套 override、保持頁面順序、缺席的 override 補在尾端、顯式補 DefaultSubmit=Apply', () => {
    const out = buildSubmitFields(parseFormFields(PAGE), {
      DSP_HandfreeVolume_RW: '3',
      SIP_PhoneLineTabIndex_R: '0', // 頁面上不存在 → 補送（未勾選 checkbox 的強制 ON 同理）
    })
    const names = out.map(([k]) => k)
    expect(out.find(([k]) => k === 'DSP_HandfreeVolume_RW')![1]).toBe('3')
    expect(names.indexOf('DSP_HandfreeVolume_RW')).toBeLessThan(names.indexOf('DSP_CodecSets_RW'))
    expect(out.find(([k]) => k === 'SIP_PhoneLineTabIndex_R')![1]).toBe('0')
    expect(out[out.length - 1]).toEqual(['DefaultSubmit', 'Apply'])
  })

  it('未 override 的欄位原值回帶（漏欄位=關功能）', () => {
    const out = buildSubmitFields(parseFormFields(PAGE), { DSP_HandfreeVolume_RW: '3' })
    expect(out.find(([k]) => k === 'SIP_EnableSipReg_RW')![1]).toBe('ON')
    expect(out.find(([k]) => k === 'DSP_CodecSets_RW')![1]).toBe('G722,PCMU,PCMA,G729')
  })
})
