// ============================================
// per-key（建議 `${ip}:${port}`）序列化佇列 ＋ 最小間隔。
// Rapid Logic web server 單執行緒、極脆弱：真機實測「4 個操作／約 10 秒」
// 就 wedge（nonce 端點回空 body，需完全零流量靜置 ~20 分鐘自癒）。防線：
//   1. 同 key 同時間最多一個 in-flight（single-flight）
//   2. 前一個「完成」到下一個「開始」至少 minIntervalMs（讀寫統一 4s —
//      wedge 主因是單次操作內的連發爆發，不分讀寫、單一保守下限最簡）
// queues Map 不淘汰：上界＝設備數（/24 至多 254 個 key、每 entry 兩個
// number＋一個 settled promise），成長有界，接受不淘汰（2026-07-22 裁決）。
// ============================================

/** 讀寫統一最小間隔（真機 wedge 攻防定案 1.5s→4s；與 UI 端節流對齊的唯一來源） */
export const DAYU_MIN_INTERVAL_MS = 4000

interface QueueState {
  tail: Promise<unknown>
  lastDoneAt: number
}

const queues = new Map<string, QueueState>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function enqueueDayu<T>(
  key: string, task: () => Promise<T>, minIntervalMs = DAYU_MIN_INTERVAL_MS
): Promise<T> {
  const q = queues.get(key) ?? { tail: Promise.resolve(), lastDoneAt: 0 }
  const run = q.tail
    .catch(() => undefined) // 前一個任務失敗不影響後續
    .then(async () => {
      const wait = q.lastDoneAt + minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        return await task()
      } finally {
        q.lastDoneAt = Date.now()
      }
    })
  q.tail = run
  queues.set(key, q)
  return run
}

export function __clearQueuesForTesting(): void {
  queues.clear()
}
