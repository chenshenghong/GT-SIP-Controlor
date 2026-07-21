// ============================================
// per-IP 序列化佇列 ＋ 最小間隔。
// Rapid Logic web server 連發請求會 connection reset / 503 / 回半頁
//（實機驗證），所以對同一設備的所有 HTTP 操作必須：
//   1. 同時間最多一個 in-flight（single-flight）
//   2. 前一個「完成」到下一個「開始」至少 minIntervalMs
// Phase 2 寫入沿用本佇列（間隔調 3000ms）。
// ============================================

interface QueueState {
  tail: Promise<unknown>
  lastDoneAt: number
}

const queues = new Map<string, QueueState>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// For testing only
export function __clearQueuesForTesting(): void {
  queues.clear()
}

export function enqueueDayu<T>(
  ip: string, task: () => Promise<T>, minIntervalMs = 1500
): Promise<T> {
  const q = queues.get(ip) ?? { tail: Promise.resolve(), lastDoneAt: 0 }
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
  queues.set(ip, q)
  return run
}
