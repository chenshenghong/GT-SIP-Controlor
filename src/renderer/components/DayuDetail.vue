<template>
  <div class="dayu-detail">
    <div class="detail-header">
      <button class="back-btn" @click="$emit('close')">← 返回列表</button>
      <h2>{{ device.name || device.ip }}</h2>
      <span class="kind-badge">DAYU-OT300</span>
    </div>

    <div class="info-grid">
      <div class="info-card"><span class="label">IP 位址</span><span class="value">{{ device.ip }}</span></div>
      <div class="info-card"><span class="label">型號</span><span class="value">{{ device.type }}</span></div>
      <div class="info-card"><span class="label">連線狀態</span><span class="value">{{ device.status === 'ONLINE' ? '🟢 可連線' : '🔴 離線' }}</span></div>
      <div class="info-card">
        <span class="label">喇叭音量等級</span>
        <span class="value">{{ media ? `${media.speakerVolume} / 9` : '—' }}</span>
      </div>
      <div class="info-card wide">
        <span class="label">Codec 順序</span>
        <span class="value">{{ media?.codecOrder || '—' }}</span>
      </div>
    </div>

    <!-- 憑證（非出廠帳密的設備在此修正；純記憶體，重啟後需重輸） -->
    <div class="section">
      <h3>裝置憑證</h3>
      <div class="form-row">
        <input v-model="cred.username" placeholder="帳號（預設 admin）" @change="saveCred" />
        <input v-model="cred.password" type="password" placeholder="密碼（預設 admin）" @change="saveCred" />
        <button class="read-btn" :disabled="!!busy" @click="readMedia">
          {{ busy === 'read' ? '讀取中…' : '🔄 重新讀取' }}
        </button>
      </div>
      <div v-if="readErr" class="outcome-line err">{{ readErr }}</div>
    </div>

    <!-- 音量寫入（canonical 0–9；media.htm readback 可信 → 可達 applied-verified） -->
    <div class="section">
      <h3>喇叭音量</h3>
      <div class="form-row">
        <input class="vol-range" type="range" min="0" max="9" step="1" v-model.number="volTarget" :disabled="!!busy" />
        <span class="vol-label">{{ volTarget }} / 9</span>
        <button class="write-btn" :disabled="!!busy" @click="applyVolume">
          {{ busy === 'volume' ? '寫入中…' : '套用音量' }}
        </button>
      </div>
      <OutcomeLine v-if="volOutcome" :outcome="volOutcome" />
    </div>

    <!-- SIP 帳號（lines.htm readback 不可信 → 恆為「已送出·未驗證」） -->
    <div class="section">
      <h3>SIP 帳號（線路 1）</h3>
      <div class="form-grid">
        <label>分機號碼<input v-model="sip.phoneNum" placeholder="155" :disabled="!!busy" /></label>
        <label>註冊帳號<input v-model="sip.regUser" :placeholder="sip.phoneNum || '同分機'" :disabled="!!busy" /></label>
        <label>顯示名稱<input v-model="sip.displayName" :placeholder="sip.phoneNum || '同分機'" :disabled="!!busy" /></label>
        <label>SIP 密碼<input v-model="sip.regPasswd" type="password" :disabled="!!busy" /></label>
        <label>SIP 伺服器<input v-model="sip.regAddr" placeholder="192.168.1.1" :disabled="!!busy" /></label>
        <label>SIP 埠<input v-model="sip.regPort" placeholder="5060" :disabled="!!busy" /></label>
      </div>
      <div class="form-row">
        <button class="write-btn" :disabled="!!busy || !sip.phoneNum || !sip.regAddr" @click="applySip">
          {{ busy === 'sip' ? '寫入中…' : '寫入 SIP 設定' }}
        </button>
      </div>
      <OutcomeLine v-if="sipOutcome" :outcome="sipOutcome" />
      <div class="note-box">
        本設備的 SIP 頁面無法可信回讀（欄位值由裝置端 JS 動態填入），寫入結果最高只到
        「已送出·未驗證」。真實註冊狀態請以 SIP 伺服器端確認（如 Asterisk
        <code>pjsip show contacts</code>）。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted, defineComponent, h, type PropType } from 'vue'
import type { DeviceNode, DayuMediaInfo, DayuWriteOutcome, DayuSipConfig } from '@shared/types'
import { useDayuCredentialStore } from '@/stores/dayuCredentials'

const props = defineProps<{ device: DeviceNode }>()
defineEmits<{ close: [] }>()

const credStore = useDayuCredentialStore()
const cred = reactive({ ...credStore.getCredentials(props.device.ip) })

const media = ref<DayuMediaInfo | null>(null)
const busy = ref<'' | 'read' | 'volume' | 'sip'>('')
const volTarget = ref(0)
const volOutcome = ref<DayuWriteOutcome | null>(null)
const sipOutcome = ref<DayuWriteOutcome | null>(null)
const readErr = ref('')

const sip = reactive<DayuSipConfig>({
  phoneNum: '', regUser: '', displayName: '', regPasswd: '',
  regAddr: (props.device.server ?? '').split(':')[0] ?? '', regPort: '5060',
})

function saveCred() {
  credStore.setCredentials(props.device.ip, cred.username, cred.password)
}

/** 四態 outcome 顯示（含 SIP ground-truth 揭露；busy 明示退避不重打） */
const OutcomeLine = defineComponent({
  props: { outcome: { type: Object as PropType<DayuWriteOutcome>, required: true } },
  setup(p) {
    return () => {
      const o = p.outcome
      const cls = { 'applied-verified': 'ok', 'applied-unverified': 'warn', busy: 'warn', failed: 'err' }[o.state]
      const text =
        o.state === 'applied-verified' ? '✅ 已寫入並回讀驗證'
        : o.state === 'applied-unverified' ? `🟡 已送出·未驗證${o.detail ? `（${o.detail}）` : ''}`
        : o.state === 'busy' ? `⏳ 設備忙碌／保護退避中${o.detail ? `（${o.detail}）` : ''}——請靜置後再試，連續重打會延長癱瘓`
        : `❌ 寫入失敗：${
            o.reason === 'auth-failed' ? '登入失敗（請檢查上方憑證）'
            : o.reason === 'verify-mismatch' ? `回讀不符（${o.detail ?? ''}）`
            : o.reason === 'parse-failed' ? `頁面異常（${o.detail ?? '拿不到完整表單，已拒發不完整寫入'}）`
            : `連線失敗${o.detail ? `（${o.detail}）` : ''}`
          }`
      return h('div', { class: ['outcome-line', cls] }, text)
    }
  },
})

async function readMedia() {
  busy.value = 'read'
  readErr.value = ''
  try {
    const r = await window.electronAPI.dayuGetMedia(props.device.ip, cred.username, cred.password)
    if (r.ok) {
      media.value = r.value
      volTarget.value = r.value.speakerVolume
    } else {
      readErr.value =
        r.reason === 'busy' ? `⏳ 設備忙碌／保護退避中，請稍後再讀取${r.detail ? `（${r.detail}）` : ''}`
        : r.reason === 'auth-failed' ? '❌ 登入失敗，請檢查上方憑證'
        : r.reason === 'parse-failed' ? '⚠️ 設備回應不完整，請稍後重試'
        : '❌ 連線失敗'
    }
  } finally {
    busy.value = ''
  }
}

async function applyVolume() {
  busy.value = 'volume'
  volOutcome.value = null
  try {
    const r = await window.electronAPI.dayuSetVolume(
      props.device.ip, volTarget.value, cred.username, cred.password
    )
    volOutcome.value = r
    // verified 時本地同步顯示；unverified 不假裝知道現值
    if (r.state === 'applied-verified' && media.value) {
      media.value = { ...media.value, speakerVolume: volTarget.value }
    }
  } finally {
    busy.value = ''
  }
}

async function applySip() {
  busy.value = 'sip'
  sipOutcome.value = null
  const cfg: DayuSipConfig = {
    ...sip,
    regUser: sip.regUser || sip.phoneNum,
    displayName: sip.displayName || sip.phoneNum,
    regPort: sip.regPort || '5060',
  }
  try {
    sipOutcome.value = await window.electronAPI.dayuSetSip(
      props.device.ip, cfg, cred.username, cred.password
    )
  } finally {
    busy.value = ''
  }
}

onMounted(readMedia) // 單次讀取；絕不背景輪詢（wedge 防護鐵律）
</script>

<style scoped>
.dayu-detail { padding: 1.5rem; }
.detail-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.detail-header h2 { margin: 0; color: #e0f2e9; font-size: 1.3rem; }
.back-btn { background: rgba(139,157,195,0.1); border: 1px solid rgba(139,157,195,0.3); color: #8b9dc3; padding: 6px 14px; border-radius: 8px; cursor: pointer; }
.kind-badge { background: rgba(255,152,0,0.15); border: 1px solid rgba(255,152,0,0.35); color: #ffcc80; padding: 3px 10px; border-radius: 999px; font-size: 0.78rem; }
.info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin-bottom: 1.25rem; }
.info-card { background: rgba(0,0,0,0.25); border: 1px solid rgba(78,222,163,0.15); border-radius: 10px; padding: 0.9rem 1rem; display: flex; flex-direction: column; gap: 6px; }
.info-card.wide { grid-column: span 4; }
.info-card .label { color: #8b9dc3; font-size: 0.78rem; }
.info-card .value { color: #e0f2e9; font-size: 1.05rem; }
.section { margin-bottom: 1.25rem; padding: 1rem 1.2rem; background: rgba(0,0,0,0.2); border: 1px solid rgba(78,222,163,0.12); border-radius: 12px; }
.section h3 { margin: 0 0 0.75rem; color: #e0f2e9; font-size: 0.95rem; }
.form-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.form-row input, .form-grid input { background: rgba(0,0,0,0.3); border: 1px solid rgba(78,222,163,0.2); color: #e0f2e9; padding: 7px 10px; border-radius: 6px; font-size: 0.85rem; }
.form-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 0.75rem; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; color: #8b9dc3; font-size: 0.78rem; }
.vol-range { flex: 1; max-width: 260px; }
.vol-label { color: #e0f2e9; min-width: 48px; }
.read-btn, .write-btn { background: linear-gradient(135deg, #4edea3, #3bc991); border: none; color: #0c1324; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: 600; }
.read-btn:disabled, .write-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.outcome-line { margin-top: 0.75rem; padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; }
.outcome-line.ok { background: rgba(78,222,163,0.1); border: 1px solid rgba(78,222,163,0.3); color: #4edea3; }
.outcome-line.warn { background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.3); color: #ffcc80; }
.outcome-line.err { background: rgba(255,82,82,0.1); border: 1px solid rgba(255,82,82,0.3); color: #ff8a80; }
.note-box { margin-top: 0.75rem; padding: 10px 14px; background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.3); border-radius: 8px; color: #ffcc80; font-size: 0.82rem; }
</style>
