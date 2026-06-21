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
  let inFlight = false

  async function poll() {
    if (!targetIp.value || inFlight) return // skip if previous poll still running
    inFlight = true
    try {
      // Device web server is flaky (frequent timeouts). Only overwrite the
      // displayed value on success — keep the last good value otherwise so the
      // panel stays stable instead of flickering to "尚未取得" on every timeout.
      const status = await getDeviceStatus(targetIp.value)
      if (status) { deviceStatus.value = status; lastError.value = null }
      const call = await getCallStatus(targetIp.value)
      if (call) callStatus.value = call
    } finally {
      inFlight = false
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
