<script setup lang="ts">
import { useToast } from '@/composables/useToast'

defineProps<{ currentView: string }>()
defineEmits<{ navigate: [view: string] }>()

const { toasts } = useToast()

const navItems = [
  { id: 'radar', label: '設備探測', icon: 'sensors' },
  { id: 'devices', label: '設備清單', icon: 'router' },
  { id: 'batch', label: '批次設定', icon: 'tune' },
  { id: 'provision', label: '自動供裝', icon: 'auto_mode' },
]
</script>

<template>
  <div class="relative min-h-screen">
    <!-- Background Grid -->
    <div
      class="fixed inset-0 pointer-events-none z-0 opacity-100"
      style="background-image: linear-gradient(to right, rgba(134, 148, 138, 0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(134, 148, 138, 0.05) 1px, transparent 1px); background-size: 24px 24px"
    ></div>

    <!-- Scanline -->
    <div class="fixed inset-0 w-full h-0.5 bg-primary/10 animate-scanline z-10 pointer-events-none"></div>

    <!-- Top Navigation -->
    <header class="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-4 bg-surface border-b border-surface-container-high">
      <div class="flex items-center gap-3">
        <span class="text-xl font-bold tracking-tighter text-primary drop-shadow-[0_0_8px_rgba(78,222,163,0.5)] font-headline">
          SIP COMMANDER
        </span>
        <div class="h-4 w-px bg-outline-variant opacity-30 mx-2"></div>
        <span class="tracking-[0.05em] uppercase text-sm text-primary">
          {{ navItems.find(n => n.id === currentView)?.label || '設備管理' }}
        </span>
      </div>
    </header>

    <!-- Side Navigation -->
    <aside class="hidden md:flex flex-col fixed left-0 top-0 h-full w-64 bg-surface border-r border-outline-variant/20 z-40 pt-24">
      <div class="px-6 mb-8">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
          <span class="text-[13px] uppercase tracking-wider text-primary">SIP COMMANDER</span>
        </div>
        <span class="text-[10px] text-on-surface-variant uppercase tracking-[0.2em]">SIP 設備管理</span>
      </div>

      <nav class="flex flex-col gap-1">
        <a
          v-for="item in navItems"
          :key="item.id"
          class="flex items-center gap-4 px-6 py-3 transition-all cursor-pointer"
          :class="
            item.id === currentView
              ? 'text-primary border-l-2 border-primary bg-gradient-to-r from-primary/10 to-transparent'
              : 'text-on-surface-variant border-l-2 border-transparent hover:bg-surface-container-high hover:text-primary'
          "
          @click="$emit('navigate', item.id)"
        >
          <span class="material-symbols-outlined text-[20px]">{{ item.icon }}</span>
          <span class="text-[13px] uppercase tracking-wider">{{ item.label }}</span>
        </a>
      </nav>

      <div class="mt-auto p-6 space-y-4">
        <div class="flex flex-col gap-2 pt-4 border-t border-outline-variant/20">
          <div class="flex items-center gap-3 text-on-surface-variant text-[11px] tracking-widest uppercase">
            <span class="material-symbols-outlined text-sm">sensors</span>
            <span>系統狀態</span>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="relative z-20 h-screen overflow-y-auto flex flex-col pt-16 md:pl-64">
      <slot />
    </main>

    <!-- Toast Container -->
    <div class="fixed bottom-4 right-4 z-[300] flex flex-col gap-2 pointer-events-none">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="pointer-events-auto min-w-[240px] max-w-sm px-4 py-3 bg-surface-container-high text-on-surface text-sm shadow-lg border-l-4"
        :class="{
          'border-primary': t.type === 'ok',
          'border-error': t.type === 'err',
          'border-[#ffab40]': t.type === 'warn',
        }"
      >
        {{ t.msg }}
      </div>
    </div>
  </div>
</template>
