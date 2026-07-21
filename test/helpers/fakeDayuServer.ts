// test/helpers/fakeDayuServer.ts
// 模擬 DAYU-OT300 Rapid Logic web server（實機行為出處：Obsidian
// 「DAYU-OT300 HTTP API 批次管理」筆記，2026-07-20/21 實測）。
// Phase 2 擴充：完整 media 表單頁、POST /media.htm 與 /lines.htm、
// 503 模式、GBK body 解析、部分 POST 靜默拒絕（真機行為）。
import * as http from 'http'
import * as crypto from 'crypto'
import * as iconv from 'iconv-lite'

export interface FakeDayuOptions {
  nonce?: string
  username?: string
  password?: string
  /** media.htm 前 N 次回半頁（無音量欄位） */
  halfPagesBeforeFull?: number
  /** nonce endpoint 前 N 次回空 body（設備過載行為） */
  emptyNoncesBeforeReal?: number
  volume?: number // 0-9
  /** 前 N 次設定 POST 回 503（server busy 行為） */
  post503Times?: number
  /** 寫入不生效（模擬 readback 不符 → verify-mismatch 測試） */
  ignoreVolumeWrites?: boolean
  /** 設定 POST 成功寫入生效後，接下來 N 次 GET /media.htm 回半頁（模擬 readback 拿不到完整頁 → applied-unverified） */
  halfPagesAfterPost?: number
}

export interface RecordedPost {
  path: string
  fields: Record<string, string>
}

export interface FakeDayu {
  port: number
  /** 觀測用：登入成功次數 */
  loginCount: number
  /** 觀測用：nonce 端點命中次數 */
  nonceHits: number
  /** 觀測用：收到的設定 POST（GBK 解碼後欄位） */
  posts: RecordedPost[]
  /** 觀測用：當前音量 */
  currentVolume: number
  /** 清掉 server 端已認證 session（模擬 session 失效） */
  invalidateSessions(): void
  close(): Promise<void>
}

const LOGIN_PAGE = '<html><head><title>Login</title></head><body>login</body></html>'

/** GBK percent-encoded body → 欄位表（decodeURIComponent 是 UTF-8，不可用） */
function decodeGbkForm(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of body.split('&')) {
    if (!pair) continue
    const [k, v = ''] = pair.split('=')
    const dec = (s: string) =>
      iconv.decode(
        Buffer.from(
          s.replace(/\+/g, ' ').replace(/%([0-9A-Fa-f]{2})/g, (_m, h) =>
            String.fromCharCode(parseInt(h, 16))
          ),
          'latin1'
        ),
        'gbk'
      )
    out[dec(k)] = dec(v)
  }
  return out
}

const mediaPage = (vol: number) =>
  '<html><body><form name="mediaForm" action="media.htm">' +
  `<input type="text" name="DSP_HandfreeVolume_RW" value="${vol}" maxlength="1">` +
  '<input type="hidden" name="DSP_CodecSets_RW" value="G722,PCMU,PCMA,G729">' +
  '<input type="hidden" name="ReturnPage" value="/media.htm">' +
  '<input type="hidden" name="MEDIA_DeviceName_RW" value="大廳喇叭">' +
  '<input type="checkbox" name="MEDIA_EnableVad_RW" value="ON" checked>' +
  '<input type="checkbox" name="MEDIA_EnableSidetone_RW" value="ON">' +
  '<select name="MEDIA_SampleRate_RW"><option value="8000">8k</option><option value="16000" selected>16k</option></select>' +
  '<input type="submit" name="DefaultSubmit" value="Apply">' +
  '</form></body></html>'

const HALF_MEDIA_PAGE =
  '<html><body><form name="mediaForm"><input name="DSP_RingVolume_RW"></form></body></html>'

// 真機行為：lines.htm 的 value 全空（由 JS 動態填入）
const LINES_PAGE =
  '<html><body><form name="linesForm" action="lines.htm">' +
  '<input type="text" name="SIP_PhoneNum_R" value="">' +
  '<input type="text" name="SIP_RegUser_R" value="">' +
  '<input type="text" name="SIP_DisPlayName_R" value="">' +
  '<input type="password" name="SIP_RegPasswd_R" value="">' +
  '<input type="text" name="SIP_RegAddr_R" value="">' +
  '<input type="text" name="SIP_RegPort_R" value="">' +
  '<input id="reg" type="checkbox" name="SIP_EnableSipReg_RW" value="ON" CHECKED>' +
  '<input type="hidden" name="SIP_PhoneLineTabIndex_R" value="0">' +
  '<select name="SIP_Transport_RW"><option value="0" selected>UDP</option><option value="1">TCP</option></select>' +
  '<input type="submit" name="DefaultSubmit" value="Apply">' +
  '</form></body></html>'

export function startFakeDayu(opts: FakeDayuOptions = {}): Promise<FakeDayu> {
  const nonce = opts.nonce ?? 'abc123nonce'
  const user = opts.username ?? 'admin'
  const pass = opts.password ?? 'admin'
  let halfLeft = opts.halfPagesBeforeFull ?? 0
  let emptyLeft = opts.emptyNoncesBeforeReal ?? 0
  let post503Left = opts.post503Times ?? 0
  let halfAfterLeft = 0 // 只在設定 POST 成功寫入後才啟動（見下方 POST handler）
  const expectedMd5 = crypto.createHash('md5').update(`${user}:${pass}:${nonce}`).digest('hex')
  const authedCookies = new Set<string>()
  const state = {
    loginCount: 0,
    nonceHits: 0,
    volume: opts.volume ?? 7,
    posts: [] as RecordedPost[],
  }

  // 真機以 GBK 編碼頁面（非 ASCII 內容需以 GBK bytes 送出才逼真）
  const sendHtml = (res: http.ServerResponse, html: string) => res.end(iconv.encode(html, 'gbk'))

  const server = http.createServer((req, res) => {
    const cookie = req.headers.cookie ?? ''
    res.setHeader('Server', 'Rapid Logic/1.1')

    if (req.method === 'GET' && req.url?.startsWith('/key==nonce')) {
      state.nonceHits++
      if (emptyLeft > 0) { emptyLeft--; res.end(''); return }
      res.end(nonce)
      return
    }

    if (req.method === 'POST' && req.url === '/') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const params = decodeGbkForm(body)
        const encoded = params['encoded'] ?? ''
        // 關鍵實機行為：沒帶 auth cookie 時，POST 被忽略、回登入頁
        if (!cookie.includes(`auth=${nonce}`) || encoded !== `${user}:${expectedMd5}`) {
          sendHtml(res, LOGIN_PAGE)
          return
        }
        state.loginCount++
        authedCookies.add(cookie)
        sendHtml(res, '<html><frameset></frameset></html>')
      })
      return
    }

    if (req.method === 'GET' && req.url === '/media.htm') {
      if (!authedCookies.has(cookie)) { sendHtml(res, LOGIN_PAGE); return }
      if (halfLeft > 0) { halfLeft--; sendHtml(res, HALF_MEDIA_PAGE); return }
      if (halfAfterLeft > 0) { halfAfterLeft--; sendHtml(res, HALF_MEDIA_PAGE); return }
      sendHtml(res, mediaPage(state.volume))
      return
    }

    if (req.method === 'GET' && req.url === '/lines.htm') {
      if (!authedCookies.has(cookie)) { sendHtml(res, LOGIN_PAGE); return }
      sendHtml(res, LINES_PAGE)
      return
    }

    if (req.method === 'POST' && (req.url === '/media.htm' || req.url === '/lines.htm')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        if (!authedCookies.has(cookie)) { sendHtml(res, LOGIN_PAGE); return }
        if (post503Left > 0) { post503Left--; res.statusCode = 503; res.end('busy'); return }
        const fields = decodeGbkForm(body)
        state.posts.push({ path: req.url!, fields })
        // 真機行為：只回帶部分欄位的 POST 被拒（寫入不生效但回 200）
        const isFullForm = 'DSP_CodecSets_RW' in fields || req.url === '/lines.htm'
        if (
          req.url === '/media.htm' && isFullForm && !opts.ignoreVolumeWrites &&
          fields['DSP_HandfreeVolume_RW'] !== undefined
        ) {
          state.volume = Number(fields['DSP_HandfreeVolume_RW'])
          // 寫入成功生效後才啟動「後續 readback 回半頁」模式（模擬 POST 成功但 readback 失敗）
          halfAfterLeft = opts.halfPagesAfterPost ?? 0
        }
        sendHtml(res, '<html><body>ok</body></html>')
      })
      return
    }

    sendHtml(res, '<html><body>index</body></html>')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        get loginCount() { return state.loginCount },
        get nonceHits() { return state.nonceHits },
        get posts() { return state.posts },
        get currentVolume() { return state.volume },
        invalidateSessions: () => authedCookies.clear(),
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
