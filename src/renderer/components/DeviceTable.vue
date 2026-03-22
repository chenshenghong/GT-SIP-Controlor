<script setup lang="ts">
import { ref, computed } from 'vue'
import type { DeviceNode } from '@shared/types'

const props = defineProps<{
  devices: DeviceNode[]
}>()

const emit = defineEmits<{
  (e: 'batch-sync', selectedDevices: DeviceNode[]): void
}>()

const selectedMacs = ref<string[]>([])

const onlineCount = computed(() => props.devices.filter((d) => d.status === 'ONLINE').length)

const isAllSelected = computed(
  () => props.devices.length > 0 && selectedMacs.value.length === props.devices.length
)

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedMacs.value = checked ? props.devices.map((d) => d.mac) : []
}

function triggerBatchSync() {
  const selected = props.devices.filter((d) => selectedMacs.value.includes(d.mac))
  emit('batch-sync', selected)
}
</script>

<template>
  <div class="flex-1 p-8">
    <!-- Header -->
    <div class="mb-8 flex justify-between items-end">
      <div>
        <h1 class="text-3xl font-bold tracking-tighter text-on-surface flex items-center gap-4">
          設備註冊表
          <span class="text-[10px] px-2 py-0.5 border border-secondary text-secondary tracking-[0.2em] font-normal">即時數據</span>
        </h1>
        <p class="text-on-surface-variant text-sm mt-1 uppercase tracking-widest">
          子網路 192.168.1.0/24 中有 {{ onlineCount }} 個節點在線
        </p>
      </div>
      <div class="flex gap-2">
        <button class="flex items-center px-4 py-2 bg-surface-container-lowest border border-outline-variant/30 text-[10px] uppercase font-bold text-on-surface-variant hover:border-primary/50 transition-colors">
          <span class="material-symbols-outlined text-sm mr-2 text-primary">filter_list</span>
          篩選
        </button>
        <button class="flex items-center px-4 py-2 bg-surface-container-lowest border border-outline-variant/30 text-[10px] uppercase font-bold text-on-surface-variant hover:border-primary/50 transition-colors">
          <span class="material-symbols-outlined text-sm mr-2 text-secondary">sort</span>
          排序
        </button>
      </div>
    </div>

    <!-- Action Bar -->
    <div class="flex justify-end mb-4">
      <button
        :disabled="selectedMacs.length === 0"
        :class="[
          'px-4 py-2 font-bold text-xs uppercase tracking-widest transition-all active:scale-95 flex items-center gap-2',
          selectedMacs.length === 0
            ? 'bg-surface-container-high text-on-surface-variant cursor-not-allowed opacity-50'
            : 'bg-primary-container text-on-primary hover:opacity-80',
        ]"
        @click="triggerBatchSync"
      >
        <span class="material-symbols-outlined text-sm">sync</span>
        大量同步 {{ selectedMacs.length > 0 ? `(${selectedMacs.length})` : '' }}
      </button>
    </div>

    <!-- Data Table -->
    <div class="bg-surface-container border border-outline-variant/20 overflow-hidden shadow-2xl">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-highest/50 border-b border-outline-variant">
            <th class="p-4 w-12 text-center">
              <input
                type="checkbox"
                :checked="isAllSelected"
                @change="toggleAll"
                class="w-4 h-4 rounded-none bg-surface-container-lowest border-outline text-primary focus:ring-primary focus:ring-offset-surface"
              />
            </th>
            <th class="p-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em]">MAC 位址</th>
            <th class="p-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em]">IP 位址</th>
            <th class="p-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em]">狀態</th>
            <th class="p-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em]">韌體版本</th>
            <th class="p-4 text-[10px] font-bold text-on-surface-variant uppercase tracking-[0.2em] text-right">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/10">
          <tr
            v-for="device in devices"
            :key="device.mac"
            class="hover:bg-surface-container-highest/60 transition-colors group"
          >
            <td class="p-4 text-center">
              <input
                type="checkbox"
                :value="device.mac"
                v-model="selectedMacs"
                class="w-4 h-4 rounded-none bg-surface-container-lowest border-outline text-primary focus:ring-primary focus:ring-offset-surface"
              />
            </td>
            <td class="p-4 font-mono text-sm text-on-surface">{{ device.mac }}</td>
            <td class="p-4 font-mono text-sm text-secondary">{{ device.ip }}</td>
            <td class="p-4">
              <span
                v-if="device.status === 'ONLINE'"
                class="inline-flex items-center gap-2 px-3 py-1 bg-primary-container/10 text-primary text-[10px] font-bold uppercase tracking-wider border border-primary/20"
              >
                <span class="w-1.5 h-1.5 bg-primary rounded-full animate-pulse"></span>
                在線
              </span>
              <span
                v-else-if="device.status === 'RECONNECTING'"
                class="inline-flex items-center gap-2 px-3 py-1 bg-secondary/10 text-secondary text-[10px] font-bold uppercase tracking-wider border border-secondary/20"
              >
                <span class="w-1.5 h-1.5 bg-secondary rounded-full animate-pulse"></span>
                重連中
              </span>
              <span
                v-else
                class="inline-flex items-center gap-2 px-3 py-1 bg-error/10 text-error text-[10px] font-bold uppercase tracking-wider border border-error/20"
              >
                <span class="w-1.5 h-1.5 bg-error rounded-full"></span>
                已斷線
              </span>
            </td>
            <td class="p-4 text-xs text-on-surface-variant">{{ device.version }}</td>
            <td class="p-4 text-right">
              <div class="flex justify-end gap-2">
                <button class="text-on-surface-variant hover:text-primary transition-colors p-1" title="Terminal">
                  <span class="material-symbols-outlined text-sm">terminal</span>
                </button>
                <button class="text-on-surface-variant hover:text-secondary transition-colors p-1" title="Sync">
                  <span class="material-symbols-outlined text-sm">sync</span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <!-- Pagination -->
      <div class="p-4 bg-surface-container-low border-t border-outline-variant/30 flex justify-between items-center">
        <div class="text-[10px] text-on-surface-variant uppercase tracking-widest font-bold">
          顯示 {{ devices.length }} 個節點
        </div>
      </div>
    </div>

    <!-- Stats Row -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mt-8">
      <div class="p-6 border-l-4 border-primary bg-surface-container">
        <div class="text-[10px] text-on-surface-variant uppercase tracking-widest font-bold mb-2">總頻寬</div>
        <div class="text-2xl font-bold text-on-surface tracking-tighter">842.4 <span class="text-xs text-on-surface-variant">MB/s</span></div>
      </div>
      <div class="p-6 border-l-4 border-secondary bg-surface-container">
        <div class="text-[10px] text-on-surface-variant uppercase tracking-widest font-bold mb-2">使用中中繼</div>
        <div class="text-2xl font-bold text-on-surface tracking-tighter">12 / 16</div>
      </div>
      <div class="p-6 border-l-4 border-error bg-surface-container">
        <div class="text-[10px] text-on-surface-variant uppercase tracking-widest font-bold mb-2">延遲告警</div>
        <div class="text-2xl font-bold text-on-surface tracking-tighter">03</div>
      </div>
      <div class="bg-surface-container-highest p-6 border border-primary/20 flex items-center justify-between">
        <div>
          <div class="text-[10px] text-primary uppercase tracking-widest font-bold mb-2">系統運作時間</div>
          <div class="text-xl font-bold text-on-surface tracking-tighter">99.982%</div>
        </div>
        <span class="material-symbols-outlined text-primary text-3xl opacity-50">query_stats</span>
      </div>
    </div>
  </div>
</template>
