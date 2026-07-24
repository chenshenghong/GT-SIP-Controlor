<script setup lang="ts">
import { reactive, ref, computed } from 'vue'
import {
  normalizeZones, validateZones, serializeZones, MZ_COUNT, MZ_CODEC_PAIRS,
} from '@shared/multicastZones'
import { setSipMulticastZones } from '@/composables/deviceApi'
import type { MulticastZone } from '@shared/types'
import { useToast } from '@/composables/useToast'

const toast = useToast()

const props = defineProps<{ ip: string; initialZones: MulticastZone[] | null }>()

const rows = reactive<MulticastZone[]>(normalizeZones(props.initialZones))
const saving = ref(false)

// 即時：已啟用區之間 priority 重複者集合（標紅用；不阻擋輸入）
const dupPriorities = computed<Set<number>>(() => {
  const seen = new Map<number, number>()
  const dup = new Set<number>()
  for (const r of rows) {
    if (!r.enabled || !r.priority) continue
    if (seen.has(r.priority)) dup.add(r.priority)
    else seen.set(r.priority, r.zone_id)
  }
  return dup
})

async function save(): Promise<void> {
  const errs = validateZones(rows)
  if (errs.length) { toast.show(errs.map((e) => e.message).join('\n'), 'err'); return }
  saving.value = true
  const res = await setSipMulticastZones(props.ip, serializeZones(rows))
  saving.value = false
  toast.show(
    res.ok ? '組播監聽區已儲存（即時生效）'
      : `儲存失敗${res.errorZoneId ? `（Zone ${res.errorZoneId}）` : ''}：${res.message ?? ''}`,
    res.ok ? 'ok' : 'err'
  )
}
</script>

<template>
  <div class="mz-wrap">
    <p class="mz-sub">16 區多監聽區，依優先權即時搶佔、不混音。Zone 1 ＝「SIP / 組播」單槽同一份設定。整表一次儲存、即時生效免重啟。</p>
    <div v-if="dupPriorities.size" class="mz-warn">
      ⚠ 優先權重複：{{ [...dupPriorities].sort((a, b) => a - b).join('、') }}（已啟用區的優先權須全域唯一，儲存前請修正）
    </div>

    <div v-for="row in rows" :key="row.zone_id" class="mz-row">
      <div class="mz-row-head">
        <b>Zone {{ row.zone_id }}</b>
        <span v-if="row.zone_id === 1" class="mz-hint">＝SIP / 組播頁單槽同一份設定</span>
        <label class="mz-en"><input type="checkbox" v-model="row.enabled" /> 啟用</label>
      </div>
      <div class="mz-grid">
        <label>組播位址 (224–239)
          <input v-model="row.multicast_address" placeholder="239.192.1.1" /></label>
        <label>組播埠 (1024–65535)
          <input v-model.number="row.multicast_port" type="number" placeholder="2000" /></label>
        <label>優先權 (1–16，越小越優先)
          <input v-model.number="row.priority" type="number" min="1" :max="MZ_COUNT"
                 :class="{ bad: row.enabled && dupPriorities.has(row.priority) }" /></label>
        <label>音頻編碼
          <select v-model="row.audio_codec">
            <option value="">（請選擇編碼）</option>
            <option v-for="[v, label] in MZ_CODEC_PAIRS" :key="v" :value="v">{{ label }}</option>
          </select></label>
      </div>
    </div>

    <button class="primary-btn" :disabled="saving" @click="save">
      {{ saving ? '儲存中…' : '儲存全部監聽區' }}
    </button>
  </div>
</template>

<style scoped>
.mz-sub { color: #8b9dc3; font-size: 0.8rem; margin: 0 0 12px; }
.mz-warn { color: #ff5252; font-size: 0.8rem; margin-bottom: 10px; }
.mz-row { border-top: 1px solid rgba(78,222,163,0.1); padding-top: 12px; margin-top: 12px; }
.mz-row-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.mz-hint { color: #8b9dc3; font-size: 0.72rem; }
.mz-en { margin-left: auto; color: #e0f2e9; font-size: 0.82rem; }
.mz-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.mz-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 0.78rem; color: #8b9dc3; }
.mz-grid input, .mz-grid select { padding: 6px 8px; background: rgba(0,0,0,0.2); border: 1px solid rgba(78,222,163,0.15); color: #e0f2e9; border-radius: 4px; }
.mz-grid input.bad { border-color: #ff5252; }
.primary-btn { margin-top: 14px; }
</style>
