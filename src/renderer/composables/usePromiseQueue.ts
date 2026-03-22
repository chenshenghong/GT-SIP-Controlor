// ============================================
// SIP CMS — Promise Queue (Concurrency Limiter)
// Phase 4: maxConcurrent: 5, NEVER use Promise.all
// ============================================
import { ref, computed, type Ref } from 'vue'

export interface QueueTask<T> {
  id: string
  execute: () => Promise<T>
}

export interface QueueResult<T> {
  id: string
  success: boolean
  data?: T
  error?: string
}

export function usePromiseQueue<T>(maxConcurrent: number = 5) {
  const completed = ref(0) as Ref<number>
  const failed = ref(0) as Ref<number>
  const total = ref(0) as Ref<number>
  const isRunning = ref(false)
  const results = ref<QueueResult<T>[]>([]) as Ref<QueueResult<T>[]>
  const currentlyRunning = ref(0) as Ref<number>

  const progress = computed(() =>
    total.value > 0 ? Math.round(((completed.value + failed.value) / total.value) * 100) : 0
  )

  async function runQueue(tasks: QueueTask<T>[]): Promise<QueueResult<T>[]> {
    // Reset state
    completed.value = 0
    failed.value = 0
    total.value = tasks.length
    results.value = []
    isRunning.value = true
    currentlyRunning.value = 0

    const queue = [...tasks]
    const allResults: QueueResult<T>[] = []

    const runNext = async (): Promise<void> => {
      while (queue.length > 0) {
        const task = queue.shift()!
        currentlyRunning.value++

        try {
          const data = await task.execute()
          const result: QueueResult<T> = { id: task.id, success: true, data }
          allResults.push(result)
          results.value = [...allResults]
          completed.value++
        } catch (err) {
          const result: QueueResult<T> = {
            id: task.id,
            success: false,
            error: String(err),
          }
          allResults.push(result)
          results.value = [...allResults]
          failed.value++
        } finally {
          currentlyRunning.value--
        }
      }
    }

    // Start N workers — this is the concurrency limit mechanism
    const workers = Array.from(
      { length: Math.min(maxConcurrent, tasks.length) },
      () => runNext()
    )
    await Promise.all(workers)

    isRunning.value = false
    return allResults
  }

  function reset() {
    completed.value = 0
    failed.value = 0
    total.value = 0
    results.value = []
    isRunning.value = false
    currentlyRunning.value = 0
  }

  return {
    completed,
    failed,
    total,
    progress,
    isRunning,
    results,
    currentlyRunning,
    runQueue,
    reset,
  }
}
