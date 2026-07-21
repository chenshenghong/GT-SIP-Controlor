import * as http from 'http'
import { probeDayu } from '../src/main/dayu/dayuScanner'
import { startFakeDayu, FakeDayu } from './helpers/fakeDayuServer'

describe('probeDayu', () => {
  let srv: FakeDayu
  let other: http.Server | null = null
  afterEach(async () => {
    if (srv) await srv.close()
    if (other) { await new Promise((r) => other!.close(() => r(null))); other = null }
  })

  it('Rapid Logic header ＋ nonce endpoint 都命中 → 回 DAYU DeviceNode（不送帳密）', async () => {
    srv = await startFakeDayu()
    const node = await probeDayu('127.0.0.1', srv.port)
    expect(node).not.toBeNull()
    expect(node!.deviceKind).toBe('dayu-ot300')
    expect(node!.type).toBe('DAYU-OT300')
    expect(node!.ip).toBe('127.0.0.1')
    expect(node!.mac).toBe('') // 掃描階段拿不到 MAC，不得登入取
    expect(srv.loginCount).toBe(0) // 指紋階段禁送帳密（Codex 審查要求）
  })

  it('一般 web server（無 Rapid Logic header）→ null', async () => {
    other = http.createServer((_q, s) => s.end('hi'))
    const port = await new Promise<number>((r) =>
      other!.listen(0, '127.0.0.1', () => r((other!.address() as { port: number }).port)))
    const node = await probeDayu('127.0.0.1', port)
    expect(node).toBeNull()
  })

  it('有 Rapid Logic header 但 nonce endpoint 無回應 → null（低信心不收）', async () => {
    other = http.createServer((req, s) => {
      s.setHeader('Server', 'Rapid Logic/1.1')
      if (req.url?.startsWith('/key==nonce')) { s.statusCode = 404; s.end(''); return }
      s.end('index')
    })
    const port = await new Promise<number>((r) =>
      other!.listen(0, '127.0.0.1', () => r((other!.address() as { port: number }).port)))
    const node = await probeDayu('127.0.0.1', port)
    expect(node).toBeNull()
  })

  it('連不上 → null', async () => {
    const node = await probeDayu('127.0.0.1', 1)
    expect(node).toBeNull()
  })

  it('nonce body 超過 64 字元 → null（低信心不收）', async () => {
    other = http.createServer((req, s) => {
      s.setHeader('Server', 'Rapid Logic/1.1')
      if (req.url?.startsWith('/key==nonce')) { s.end('x'.repeat(65)); return }
      s.end('index')
    })
    const port = await new Promise<number>((r) =>
      other!.listen(0, '127.0.0.1', () => r((other!.address() as { port: number }).port)))
    expect(await probeDayu('127.0.0.1', port)).toBeNull()
  })

  it('nonce body 是 HTML（含 <）→ null', async () => {
    other = http.createServer((req, s) => {
      s.setHeader('Server', 'Rapid Logic/1.1')
      if (req.url?.startsWith('/key==nonce')) { s.end('<html>err</html>'); return }
      s.end('index')
    })
    const port = await new Promise<number>((r) =>
      other!.listen(0, '127.0.0.1', () => r((other!.address() as { port: number }).port)))
    expect(await probeDayu('127.0.0.1', port)).toBeNull()
  })
})
