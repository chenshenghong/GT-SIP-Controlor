// ============================================
// SIP CMS — Reconnect Composable
// Phase 5: Short polling ping + cleanup on unmount
// ============================================
import { ref, onUnmounted } from 'vue'
import { RECONNECT_POLL_INTERVAL_MS, RECONNECT_TIMEOUT_SEC } from '@shared/constants'

export function useReconnect() {
  const isReconnecting = ref(false)
  const countdown = ref(RECONNECT_TIMEOUT_SEC)
  const connected = ref(false)

  let countdownInterval: ReturnType<typeof setInterval> | null = null
  let pollInterval: ReturnType<typeof setInterval> | null = null
  let abortController: AbortController | null = null

  function startReconnectWatch(
    targetIp: string,
    onSuccess: () => void,
    onTimeout: () => void
  ) {
    cleanup() // Clear any previous watchers

    isReconnecting.value = true
    connected.value = false
    countdown.value = RECONNECT_TIMEOUT_SEC
    abortController = new AbortController()

    // Countdown timer (1s interval)
    countdownInterval = setInterval(() => {
      countdown.value--
      if (countdown.value <= 0) {
        cleanup()
        isReconnecting.value = false
        onTimeout()
      }
    }, 1000)

    // Polling ping (3s interval)
    pollInterval = setInterval(async () => {
      if (abortController?.signal.aborted) return

      try {
        const isAlive = await window.electronAPI.pingDevice(targetIp)
        if (isAlive) {
          cleanup()
          connected.value = true
          isReconnecting.value = false
          onSuccess()
        }
      } catch {
        // Ignore errors during polling
      }
    }, RECONNECT_POLL_INTERVAL_MS)
  }

  function cleanup() {
    if (countdownInterval) {
      clearInterval(countdownInterval)
      countdownInterval = null
    }
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    if (abortController) {
      abortController.abort()
      abortController = null
    }
  }

  // CRITICAL: Clean up on component unmount to prevent memory leaks
  onUnmounted(() => {
    cleanup()
  })

  return {
    isReconnecting,
    countdown,
    connected,
    startReconnectWatch,
    cleanup,
  }
}
