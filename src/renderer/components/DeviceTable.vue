<template>
  <div class="device-table-container">
    <div class="table-toolbar">
      <h3>設備註冊表</h3>
      <div class="toolbar-actions">
        <span class="device-count">共 {{ devices.length }} 台設備</span>
        <span v-if="duplicateIps.length" class="duplicate-alert">
          ⚠️ {{ duplicateIps.length }} 組 IP 衝突
        </span>
      </div>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th class="col-status">狀態</th>
            <th class="col-name">名稱</th>
            <th class="col-type">類型</th>
            <th class="col-ip">IP 位址</th>
            <th class="col-mac">MAC 位址</th>
            <th class="col-version">韌體版本</th>
            <th class="col-vol">播放</th>
            <th class="col-vol">錄入</th>
            <th class="col-sip">SIP Server</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="device in devices" :key="device.mac"
            :class="{ 'duplicate-row': getIpCount(device.ip) > 1 }"
            @click="$emit('select', device)">
            <td>
              <span :class="['status-dot', device.status.toLowerCase()]"></span>
            </td>
            <td class="name-cell">{{ device.name || device.hostName || '—' }}</td>
            <td>{{ device.type || device.mode }}</td>
            <td class="ip-cell">
              {{ device.ip }}
              <span v-if="getIpCount(device.ip) > 1" class="ip-conflict">
                ×{{ getIpCount(device.ip) }}
              </span>
            </td>
            <td><code>{{ device.mac }}</code></td>
            <td>{{ device.version }}</td>
            <td class="vol-cell">{{ device.playVol }}</td>
            <td class="vol-cell">{{ device.captureVol }}</td>
            <td class="server-cell">{{ device.server || '—' }}</td>
            <td class="actions-cell" @click.stop>
              <button class="action-btn ip-btn" @click="$emit('changeIp', device)"
                title="修改 IP">
                🔧 IP
              </button>
              <button class="action-btn detail-btn" @click="$emit('select', device)"
                title="設備詳情">
                📋
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Summary Cards -->
    <div class="summary-cards">
      <div class="card">
        <span class="card-label">線上設備</span>
        <span class="card-value online">{{ onlineCount }}</span>
      </div>
      <div class="card">
        <span class="card-label">離線設備</span>
        <span class="card-value offline">{{ offlineCount }}</span>
      </div>
      <div class="card">
        <span class="card-label">IP 衝突</span>
        <span class="card-value" :class="duplicateIps.length ? 'warning' : ''">{{ duplicateIps.length }}</span>
      </div>
      <div class="card">
        <span class="card-label">設備類型</span>
        <span class="card-value">{{ deviceTypes }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { DeviceNode } from '@shared/types'

const props = defineProps<{ devices: DeviceNode[] }>()
defineEmits<{
  select: [device: DeviceNode]
  changeIp: [device: DeviceNode]
}>()

const onlineCount = computed(() => props.devices.filter(d => d.status === 'ONLINE').length)
const offlineCount = computed(() => props.devices.filter(d => d.status !== 'ONLINE').length)
const deviceTypes = computed(() => new Set(props.devices.map(d => d.type || d.mode)).size)

// IP conflict detection
const ipCountMap = computed(() => {
  const map: Record<string, number> = {}
  for (const d of props.devices) {
    map[d.ip] = (map[d.ip] || 0) + 1
  }
  return map
})

const duplicateIps = computed(() =>
  Object.entries(ipCountMap.value).filter(([, count]) => count > 1).map(([ip]) => ip)
)

function getIpCount(ip: string): number {
  return ipCountMap.value[ip] || 0
}
</script>

<style scoped>
.device-table-container { padding: 1rem 0; }
.table-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
.table-toolbar h3 { margin: 0; color: #e0f2e9; font-size: 1.05rem; }
.toolbar-actions { display: flex; gap: 1rem; align-items: center; }
.device-count { color: #8b9dc3; font-size: 0.85rem; }
.duplicate-alert { background: rgba(255,82,82,0.15); color: #ff8a80; padding: 4px 12px; border-radius: 12px; font-size: 0.8rem; animation: pulse 2s infinite; }

.table-scroll { overflow-x: auto; border-radius: 12px; border: 1px solid rgba(78,222,163,0.1); }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
thead { background: rgba(0,0,0,0.3); }
th { padding: 10px 12px; text-align: left; color: #8b9dc3; font-weight: 500; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
td { padding: 10px 12px; color: #e0f2e9; border-top: 1px solid rgba(78,222,163,0.05); }
tr { cursor: pointer; transition: background 0.15s; }
tr:hover { background: rgba(78,222,163,0.05); }
tr.duplicate-row { background: rgba(255,82,82,0.05); }
tr.duplicate-row:hover { background: rgba(255,82,82,0.1); }

.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.status-dot.online { background: #4edea3; box-shadow: 0 0 6px rgba(78,222,163,0.5); }
.status-dot.disconnected { background: #ff5252; }
.status-dot.reconnecting { background: #ffab40; animation: pulse 1s infinite; }

.name-cell { font-weight: 500; }
.ip-cell { font-family: 'JetBrains Mono', monospace; }
.ip-conflict { background: rgba(255,82,82,0.2); color: #ff5252; padding: 1px 6px; border-radius: 8px; font-size: 0.7rem; margin-left: 6px; font-weight: 700; }
code { background: rgba(78,222,163,0.1); padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; color: #8b9dc3; }
.vol-cell { text-align: center; color: #4edea3; font-weight: 600; }
.server-cell { color: #8b9dc3; font-size: 0.8rem; }

.actions-cell { display: flex; gap: 6px; }
.action-btn { background: none; border: 1px solid rgba(78,222,163,0.2); color: #8b9dc3; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 0.75rem; transition: all 0.2s; }
.action-btn:hover { border-color: #4edea3; color: #4edea3; background: rgba(78,222,163,0.1); }
.ip-btn:hover { border-color: #ffab40; color: #ffab40; }

.summary-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 1rem; }
.card { background: rgba(0,0,0,0.2); border: 1px solid rgba(78,222,163,0.1); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
.card-label { color: #8b9dc3; font-size: 0.75rem; }
.card-value { color: #e0f2e9; font-size: 1.3rem; font-weight: 700; }
.card-value.online { color: #4edea3; }
.card-value.offline { color: #ff5252; }
.card-value.warning { color: #ffab40; }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
</style>
