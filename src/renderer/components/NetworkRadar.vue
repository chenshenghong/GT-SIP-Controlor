<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  currentIp: string
  progress: number // 0-254
  isScanning: boolean
  elapsedSeconds: number
}>()

const progressPercent = computed(() =>
  Math.round((props.progress / 254) * 100)
)

const scanTime = computed(() => {
  const s = props.elapsedSeconds
  const hrs = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = s % 60
  return [hrs, mins, secs].map((v) => (v < 10 ? '0' + v : v)).join(':')
})

const bufferSpeed = computed(() => (Math.random() * 2 + 7.5).toFixed(2))
const barSegments = computed(() => Math.floor(props.progress / 32) + 1)
</script>

<template>
  <div class="flex flex-col items-center justify-center flex-1 p-6">
    <!-- Radar -->
    <div class="relative w-72 h-72 md:w-[420px] md:h-[420px] mb-10">
      <!-- Rings -->
      <div class="absolute inset-0 rounded-full border border-outline-variant opacity-40"></div>
      <div class="absolute inset-[15%] rounded-full border border-outline-variant opacity-30"></div>
      <div class="absolute inset-[30%] rounded-full border border-outline-variant opacity-20"></div>
      <div class="absolute inset-[45%] rounded-full border border-outline-variant opacity-10"></div>
      <!-- Axes -->
      <div class="absolute top-1/2 left-0 w-full h-px bg-outline-variant opacity-20"></div>
      <div class="absolute top-0 left-1/2 w-px h-full bg-outline-variant opacity-20"></div>
      <!-- Sweep -->
      <div
        v-if="isScanning"
        class="absolute inset-0 rounded-full animate-radar-sweep pointer-events-none"
        style="background: conic-gradient(from 0deg, rgba(78, 222, 163, 0.4) 0deg, transparent 90deg)"
      ></div>
      <!-- Blips -->
      <div class="absolute top-[20%] left-[30%] w-2 h-2 bg-primary rounded-full shadow-[0_0_10px_#4edea3] opacity-80"></div>
      <div class="absolute bottom-[35%] right-[25%] w-2 h-2 bg-secondary rounded-full shadow-[0_0_10px_#4cd7f6] opacity-60"></div>
      <div class="absolute top-[60%] left-[15%] w-1.5 h-1.5 bg-error rounded-full shadow-[0_0_10px_#ffb4ab] opacity-40"></div>
      <!-- Center -->
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 bg-surface border border-primary z-30"></div>
    </div>

    <!-- Status Line -->
    <div class="w-full max-w-2xl space-y-6">
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-outline-variant/30 pb-4">
        <div class="space-y-1">
          <h2 class="text-secondary font-mono text-sm tracking-[0.3em] uppercase">
            狀態：{{ isScanning ? '正在初始化探測...' : '探測暫停' }}
          </h2>
          <div class="flex items-center gap-3">
            <div :class="{ 'animate-bounce-x': isScanning }" class="flex items-center">
              <span class="text-primary font-mono text-xl md:text-2xl font-bold tracking-tighter">
                正在掃描網路: {{ currentIp }}
              </span>
            </div>
            <span v-if="isScanning" class="inline-block w-2 h-6 bg-primary animate-pulse"></span>
          </div>
        </div>
        <div class="text-right">
          <span class="text-on-surface-variant font-mono text-xs uppercase tracking-widest">已耗時: {{ scanTime }}</span>
        </div>
      </div>

      <!-- Progress Bar -->
      <div class="space-y-3">
        <div class="flex justify-between items-center text-[10px] uppercase tracking-[0.2em] font-bold">
          <span class="text-on-surface-variant">封包分析</span>
          <span class="text-secondary">{{ progress }} / 254 個節點</span>
        </div>
        <div class="relative h-4 bg-surface-container-low border border-outline-variant p-0.5 overflow-hidden">
          <div
            :style="{ width: progressPercent + '%' }"
            class="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-300 relative"
          >
            <div class="absolute inset-0 bg-[linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.2)_50%,transparent_100%)] translate-x-[-100%] animate-shimmer"></div>
          </div>
        </div>
        <div class="flex justify-between gap-2">
          <div class="flex gap-1">
            <div
              v-for="n in 8"
              :key="n"
              :class="n <= barSegments ? 'bg-primary' : 'bg-outline-variant/30'"
              class="w-1 h-3 transition-colors duration-200"
            ></div>
          </div>
          <span class="text-on-surface-variant font-mono text-[10px] uppercase">緩衝: {{ bufferSpeed }} MB/s</span>
        </div>
      </div>

      <!-- Data Grid -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-px bg-outline-variant/20 border border-outline-variant/20 mt-8">
        <div class="bg-surface-container-low p-4 space-y-1">
          <span class="text-[9px] uppercase tracking-widest text-on-surface-variant">活動連接埠</span>
          <p class="text-secondary font-bold text-lg">1,244</p>
        </div>
        <div class="bg-surface-container-low p-4 space-y-1">
          <span class="text-[9px] uppercase tracking-widest text-on-surface-variant">延遲</span>
          <p class="text-primary font-bold text-lg">{{ Math.floor(Math.random() * 10 + 8) }}ms</p>
        </div>
        <div class="bg-surface-container-low p-4 space-y-1">
          <span class="text-[9px] uppercase tracking-widest text-on-surface-variant">威脅等級</span>
          <p class="text-error font-bold text-lg">低</p>
        </div>
        <div class="bg-surface-container-low p-4 space-y-1">
          <span class="text-[9px] uppercase tracking-widest text-on-surface-variant">加密協議</span>
          <p class="text-on-surface font-bold text-lg uppercase">AES-256</p>
        </div>
      </div>
    </div>
  </div>
</template>
