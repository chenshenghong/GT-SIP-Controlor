// ============================================
// SIP CMS — Device Status Polling Composable
// Per REST API spec: 3-second short polling for
// GET /get/device/status + GET /get/call/status
// ============================================
import { ref, onUnmounted, type Ref } from 'vue'
import { STATUS_POLL_INTERVAL_MS } from '@shared/constants'
import { getDeviceStatus, getCallStatus } from '@/composables/deviceApi'
import type { DeviceStatus, CallStatus } from '@shared/types'

export function useDevicePolling(targetIp: Ref<string>) {
  const deviceStatus = ref<DeviceStatus | null>(null)
  const callStatus = ref<CallStatus | null>(null)
  const isPolling = ref(false)
  const lastError = ref<string | null>(null)

  let pollInterval: ReturnType<typeof setInterval> | null = null

  async function poll() {
    if (!targetIp.value) return

    try {
      const [status, call] = await Promise.all([
        getDeviceStatus(targetIp.value),
        getCallStatus(targetIp.value),
      ])
      deviceStatus.value = status
      callStatus.value = call
      lastError.value = null
    } catch (err) {
      lastError.value = String(err)
    }
  }

  function startPolling() {
    stopPolling() // Clear any existing
    isPolling.value = true
    poll() // Immediate first poll
    pollInterval = setInterval(poll, STATUS_POLL_INTERVAL_MS)
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    isPolling.value = false
  }

  // CRITICAL: Clean up on component unmount to prevent memory leaks
  onUnmounted(() => {
    stopPolling()
  })

  return {
    deviceStatus,
    callStatus,
    isPolling,
    lastError,
    startPolling,
    stopPolling,
  }
}
