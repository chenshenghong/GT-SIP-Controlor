import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProvisionConfig, ProvisionEvent, ProvisionTask } from '@shared/types'

export interface LogLine { ts: number; message: string }

export const useProvisioningStore = defineStore('provisioning', () => {
  const config = ref<ProvisionConfig | null>(null)
  const tasks = ref<ProvisionTask[]>([])
  const logs = ref<LogLine[]>([])
  const running = ref(false)
  const paused = ref(false)
  const degraded = ref(false)
  const round = ref(0)
  const pool = ref({ ipUsed: 0, ipTotal: 0, extUsed: 0, extTotal: 0 })

  function upsertTask(t: ProvisionTask) {
    const i = tasks.value.findIndex((x) => x.mac === t.mac)
    if (i >= 0) tasks.value[i] = t
    else tasks.value.push(t)
  }

  function applyEvent(e: ProvisionEvent) {
    if (e.kind === 'task') upsertTask(e.task)
    else if (e.kind === 'log') {
      logs.value.push({ ts: e.ts, message: e.message })
      if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500)
    } else if (e.kind === 'paused') paused.value = true
    else if (e.kind === 'degraded') degraded.value = true
    else if (e.kind === 'pool') pool.value = { ipUsed: e.ipUsed, ipTotal: e.ipTotal, extUsed: e.extUsed, extTotal: e.extTotal }
    else if (e.kind === 'round') round.value = e.round
  }

  function setRunning(b: boolean) { running.value = b; if (b) paused.value = false }
  function reset() { tasks.value = []; logs.value = []; round.value = 0; paused.value = false; degraded.value = false }

  return { config, tasks, logs, running, paused, degraded, round, pool, applyEvent, upsertTask, setRunning, reset }
})
