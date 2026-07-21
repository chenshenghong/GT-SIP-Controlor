import * as http from 'http'
import * as crypto from 'crypto'

export interface FakeDayuOptions {
  nonce?: string
  username?: string
  password?: string
  /** media.htm 前 N 次回半頁（無音量欄位） */
  halfPagesBeforeFull?: number
  /** nonce endpoint 前 N 次回空 body（設備過載行為） */
  emptyNoncesBeforeReal?: number
  volume?: number // 0-9
}

export interface FakeDayu {
  port: number
  /** 觀測用：登入成功次數 */
  loginCount: number
  close(): Promise<void>
}

const LOGIN_PAGE = '<html><head><title>Login</title></head><body>login</body></html>'

export function startFakeDayu(opts: FakeDayuOptions = {}): Promise<FakeDayu> {
  const nonce = opts.nonce ?? 'abc123nonce'
  const user = opts.username ?? 'admin'
  const pass = opts.password ?? 'admin'
  let halfLeft = opts.halfPagesBeforeFull ?? 0
  let emptyLeft = opts.emptyNoncesBeforeReal ?? 0
  const volume = opts.volume ?? 7
  const expectedMd5 = crypto.createHash('md5').update(`${user}:${pass}:${nonce}`).digest('hex')
  const authedCookies = new Set<string>()
  const state = { loginCount: 0 }

  const server = http.createServer((req, res) => {
    const cookie = req.headers.cookie ?? ''
    const setHeaders = () => res.setHeader('Server', 'Rapid Logic/1.1')
    setHeaders()

    if (req.method === 'GET' && req.url?.startsWith('/key==nonce')) {
      if (emptyLeft > 0) { emptyLeft--; res.end(''); return }
      res.end(nonce)
      return
    }

    if (req.method === 'POST' && req.url === '/') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const params = new URLSearchParams(body)
        const encoded = params.get('encoded') ?? ''
        // 關鍵實機行為：沒帶 auth cookie 時，POST 被忽略、回登入頁
        if (!cookie.includes(`auth=${nonce}`) || encoded !== `${user}:${expectedMd5}`) {
          res.end(LOGIN_PAGE)
          return
        }
        state.loginCount++
        authedCookies.add(cookie)
        res.end('<html><frameset></frameset></html>')
      })
      return
    }

    if (req.method === 'GET' && req.url === '/media.htm') {
      if (!authedCookies.has(cookie)) { res.end(LOGIN_PAGE); return }
      if (halfLeft > 0) {
        halfLeft--
        res.end('<html><body><form name="mediaForm"><input name="DSP_RingVolume_RW"></form></body></html>')
        return
      }
      res.end(
        '<html><body><form name="mediaForm">' +
        `<input type="text" name="DSP_HandfreeVolume_RW" value="${volume}" maxlength="1">` +
        '<input type="text" name="DSP_CodecSets_RW" value="G722,PCMU,PCMA,G729">' +
        '</form></body></html>'
      )
      return
    }

    res.end('<html><body>index</body></html>')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        port,
        get loginCount() { return state.loginCount },
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
