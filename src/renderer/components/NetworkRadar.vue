<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  isScanning: boolean
  found: number
  elapsedMs: number
}>()

const emit = defineEmits<{
  'start-scan': []
}>()

const EXPECTED_MS = 4000
const progressPercent = computed(() =>
  props.isScanning
    ? Math.min(98, Math.round((props.elapsedMs / EXPECTED_MS) * 100))
    : (props.found > 0 ? 100 : 0)
)

const scanTime = computed(() => {
  const totalSec = Math.floor((props.elapsedMs || 0) / 1000)
  const hrs = Math.floor(totalSec / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  return [hrs, mins, secs].map((v) => (v < 10 ? '0' + v : v)).join(':')
})

const barSegments = computed(() =>
  Math.min(8, Math.floor((props.elapsedMs / EXPECTED_MS) * 8) + (props.isScanning ? 1 : 0))
)
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
            狀態：{{ isScanning ? 'DBP 廣播探測中...' : '待機' }}
          </h2>
          <button v-if="!isScanning"
            class="text-primary border border-primary/30 px-4 py-1 text-xs font-mono tracking-widest hover:bg-primary/10 transition-colors mt-2"
            @click="$emit('start-scan')">
            ▶ 掃描設備 (DBP 廣播)
          </button>
          <div class="flex items-center gap-3">
            <div :class="{ 'animate-bounce-x': isScanning }" class="flex items-center">
              <span class="text-primary font-mono text-xl md:text-2xl font-bold tracking-tighter">
                {{ isScanning ? 'DBP 廣播探測中...' : (found > 0 ? `已發現 ${found} 台設備` : '準備掃描設備') }}
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
          <span class="text-on-surface-variant">DBP 廣播探測</span>
          <span class="text-secondary">已發現 {{ found }} 台設備</span>
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
          <span class="text-on-surface-variant font-mono text-[10px] uppercase">已發現: {{ found }} 台</span>
        </div>
      </div>

      <!-- Data Grid -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-px bg-outline-variant/20 border border-outline-variant/20 mt-8">
        <div class="bg-surface-container-low p-4 space-y-1">
          <span class="text-[9px] uppercase tracking-widest text-on-surface-variant">已發現設備</span>
          <p class="text-secondary font-bold text-lg">{{ found }}</p>
        </div>
        <div class="bg-surface-container-low p-4 space-y-1">
          <span class="text-[9px] uppercase tracking-widest text-on-surface-variant">已耗時</span>
          <p class="text-primary font-bold text-lg">{{ scanTime }}</p>
        </div>
        <div class="bg-surface-container-low p-4 space-y-1">
          <span class="text-[9px] uppercase tracking-widest text-on-surface-variant">狀態</span>
          <p class="text-error font-bold text-lg">{{ isScanning ? '掃描中' : '待機' }}</p>
        </div>
        <div class="bg-surface-container-low p-4 space-y-1">
          <span class="text-[9px] uppercase tracking-widest text-on-surface-variant">探測協定</span>
          <p class="text-on-surface font-bold text-lg uppercase">DBP/1.0</p>
        </div>
      </div>
    </div>
  </div>
</template>
