<script setup lang="ts">
import { useReconnect } from '@/composables/useReconnect'

const props = defineProps<{
  show: boolean
  targetIp: string
}>()

const emit = defineEmits<{
  (e: 'reconnected'): void
  (e: 'timeout'): void
}>()

const { isReconnecting, countdown, connected, startReconnectWatch } = useReconnect()

// Watch show prop to start/stop
import { watch } from 'vue'
watch(
  () => props.show,
  (visible) => {
    if (visible && props.targetIp) {
      startReconnectWatch(
        props.targetIp,
        () => emit('reconnected'),
        () => emit('timeout')
      )
    }
  },
  { immediate: true }
)

const countdownPercent = (sec: number) => Math.round((sec / 45) * 100)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show && isReconnecting"
      class="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-surface/95 backdrop-blur-xl"
    >
      <!-- Pulsating ring -->
      <div class="relative w-48 h-48 mb-12">
        <div class="absolute inset-0 rounded-full border-2 border-secondary/30 animate-ping"></div>
        <div class="absolute inset-4 rounded-full border border-primary/20"></div>
        <div class="absolute inset-0 flex items-center justify-center">
          <span class="text-5xl font-black text-primary font-mono">{{ countdown }}</span>
        </div>
      </div>

      <!-- Status Text -->
      <div class="text-center space-y-4 max-w-md">
        <h2 class="text-2xl font-bold text-on-surface tracking-tight">設備正在重新啟動</h2>
        <p class="text-on-surface-variant text-sm uppercase tracking-widest">
          正在等待 <span class="text-secondary font-mono">{{ targetIp }}</span> 回應...
        </p>

        <!-- Progress bar -->
        <div class="w-64 mx-auto h-1 bg-surface-container-highest overflow-hidden mt-8">
          <div
            :style="{ width: countdownPercent(countdown) + '%' }"
            class="h-full bg-gradient-to-r from-primary to-secondary transition-all duration-1000"
          ></div>
        </div>

        <p class="text-[10px] text-on-surface-variant/50 uppercase tracking-[0.3em] mt-4">
          若設備提前重啟完成，將自動跳轉
        </p>
      </div>
    </div>
  </Teleport>
</template>
