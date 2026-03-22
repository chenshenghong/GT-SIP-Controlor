<script setup lang="ts">
import { ref, computed } from 'vue'
import type { DeviceNode, DeviceSyncEntry } from '@shared/types'
import { usePromiseQueue } from '@/composables/usePromiseQueue'
import { createDeviceApiClient, loginToDevice } from '@/composables/deviceApi'
import { MAX_CONCURRENT_SYNC, DEVICE_DEFAULT_PASSWORD } from '@shared/constants'

const props = defineProps<{
  show: boolean
  selectedDevices: DeviceNode[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

// Sync settings
const broadcastVolume = ref(82)
const multicastIp = ref('239.192.1.1')

// Queue
const queue = usePromiseQueue<void>(MAX_CONCURRENT_SYNC)

// Per-device status list
const deviceStatuses = ref<DeviceSyncEntry[]>([])

const totalDevices = computed(() => props.selectedDevices.length)

function getStatusIcon(status: DeviceSyncEntry['status']): string {
  switch (status) {
    case 'SUCCESS': return 'check_circle'
    case 'SYNCING': return 'sync'
    case 'PENDING': return 'hourglass_empty'
    case 'FAILED': return 'error_outline'
    default: return 'help'
  }
}

function getStatusText(status: DeviceSyncEntry['status']): string {
  switch (status) {
    case 'SUCCESS': return '成功'
    case 'SYNCING': return '同步中'
    case 'PENDING': return '等待中'
    case 'FAILED': return '失敗'
    default: return '未知'
  }
}

async function startSync() {
  // Init device statuses
  deviceStatuses.value = props.selectedDevices.map((d) => ({
    ip: d.ip,
    mac: d.mac,
    status: 'PENDING' as const,
  }))

  const tasks = props.selectedDevices.map((device) => ({
    id: device.ip,
    execute: async () => {
      // Update to SYNCING
      const idx = deviceStatuses.value.findIndex((ds) => ds.ip === device.ip)
      if (idx >= 0) {
        deviceStatuses.value[idx] = { ...deviceStatuses.value[idx], status: 'SYNCING' }
        deviceStatuses.value = [...deviceStatuses.value]
      }

      // Login first
      await loginToDevice(device.ip, DEVICE_DEFAULT_PASSWORD)

      // Send settings
      const api = createDeviceApiClient(device.ip)
      await api.post('/set/multicast/config', {
        volume: broadcastVolume.value,
        multicast_ip: multicastIp.value,
      })

      // Update to SUCCESS
      if (idx >= 0) {
        deviceStatuses.value[idx] = { ...deviceStatuses.value[idx], status: 'SUCCESS' }
        deviceStatuses.value = [...deviceStatuses.value]
      }
    },
  }))

  const results = await queue.runQueue(tasks)

  // Mark failed ones
  for (const r of results) {
    if (!r.success) {
      const idx = deviceStatuses.value.findIndex((ds) => ds.ip === r.id)
      if (idx >= 0) {
        deviceStatuses.value[idx] = {
          ...deviceStatuses.value[idx],
          status: 'FAILED',
          error: r.error,
        }
        deviceStatuses.value = [...deviceStatuses.value]
      }
    }
  }
}

function close() {
  queue.reset()
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-surface/80 backdrop-blur-md p-4"
    >
      <div class="w-full max-w-2xl bg-surface-container shadow-2xl border border-outline-variant/20 relative overflow-hidden">
        <!-- Neon Accent Line -->
        <div class="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-primary to-secondary"></div>

        <!-- Header -->
        <div class="flex items-center justify-between px-8 py-6 bg-surface-container-high">
          <h2 class="text-2xl font-black uppercase tracking-tighter flex items-center gap-3">
            <span class="material-symbols-outlined text-primary">sync_alt</span>
            大量同步設定
          </h2>
          <button @click="close" class="text-on-surface-variant hover:text-error transition-colors">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>

        <div class="p-8 space-y-8">
          <!-- Controls Grid -->
          <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <!-- Volume Slider -->
            <div class="space-y-4">
              <label class="block text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                廣播音量 <span class="text-primary ml-2 font-mono">{{ broadcastVolume }}%</span>
              </label>
              <div class="relative w-full h-8 flex items-center">
                <input
                  type="range"
                  min="0"
                  max="100"
                  v-model="broadcastVolume"
                  class="w-full h-1 bg-surface-container-highest appearance-none cursor-pointer accent-primary"
                />
                <div
                  :style="{ width: broadcastVolume + '%' }"
                  class="absolute h-1 bg-primary pointer-events-none shadow-[0_0_10px_#10b981]"
                ></div>
              </div>
            </div>
            <!-- Multicast IP -->
            <div class="space-y-4">
              <label class="block text-xs font-bold uppercase tracking-widest text-on-surface-variant">多播 IP 目標</label>
              <input
                type="text"
                v-model="multicastIp"
                class="w-full bg-surface-container-lowest border-0 border-b-2 border-outline-variant focus:border-secondary focus:ring-0 font-mono text-secondary px-0 py-2 transition-all outline-none"
              />
            </div>
          </div>

          <!-- Progress -->
          <div class="bg-surface-container-lowest p-6 border-l-2 border-primary/40">
            <div class="flex justify-between items-end mb-4">
              <div>
                <div class="text-[10px] font-bold uppercase text-on-surface-variant tracking-[0.2em]">同步進度</div>
                <div class="text-lg font-mono font-bold">
                  {{ queue.completed.value + queue.failed.value }}
                  <span class="text-on-surface-variant font-normal text-sm">/ {{ totalDevices }} 台設備</span>
                </div>
              </div>
              <div class="text-2xl font-black text-primary italic">{{ queue.progress.value }}%</div>
            </div>
            <div class="w-full h-3 bg-surface-container-highest overflow-hidden">
              <div
                :style="{ width: queue.progress.value + '%' }"
                class="h-full bg-gradient-to-r from-primary-container to-primary transition-all duration-1000 ease-out"
              ></div>
            </div>
          </div>

          <!-- Device Status List -->
          <div class="space-y-4">
            <div class="flex justify-between items-center text-[10px] font-bold uppercase text-on-surface-variant tracking-widest">
              <span>執行中網路節點</span>
              <span>最終狀態</span>
            </div>
            <div class="max-h-48 overflow-y-auto pr-2 space-y-1 custom-scrollbar">
              <div
                v-for="(node, i) in deviceStatuses"
                :key="node.ip"
                class="flex items-center justify-between p-3 bg-surface-container-low hover:bg-surface-container-high transition-colors"
              >
                <div class="flex items-center gap-4">
                  <span class="text-[10px] text-outline opacity-50 font-mono">{{ String(i + 1).padStart(2, '0') }}</span>
                  <span class="font-mono text-sm">{{ node.mac }}</span>
                </div>
                <div
                  :class="{
                    'text-primary': node.status === 'SUCCESS',
                    'text-secondary animate-pulse': node.status === 'SYNCING',
                    'text-on-surface-variant/40': node.status === 'PENDING',
                    'text-error': node.status === 'FAILED',
                  }"
                  class="flex items-center gap-2 text-[10px] font-bold uppercase"
                >
                  <span>{{ getStatusText(node.status) }}</span>
                  <span class="material-symbols-outlined text-sm">{{ getStatusIcon(node.status) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center justify-end gap-4 p-8 bg-surface-container-low border-t border-outline-variant/10">
          <button
            @click="close"
            class="px-6 py-2 text-on-surface-variant font-bold uppercase text-xs tracking-widest hover:text-on-surface border border-transparent hover:border-outline-variant/30 transition-all"
          >
            取消操作
          </button>
          <button
            @click="startSync"
            :disabled="queue.isRunning.value"
            class="px-8 py-3 bg-primary-container text-on-primary font-bold uppercase text-xs tracking-[0.2em] shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ queue.isRunning.value ? '同步中...' : '開始系統同步' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar { width: 4px; }
.custom-scrollbar::-webkit-scrollbar-track { background: #070d1f; }
.custom-scrollbar::-webkit-scrollbar-thumb { background: #3c4a42; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #10b981; }

input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  background: #4edea3;
  cursor: pointer;
  border-radius: 2px;
}
</style>
