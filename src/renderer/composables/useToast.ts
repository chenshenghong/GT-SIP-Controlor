import { ref } from 'vue'

export interface ToastItem {
  id: number
  msg: string
  type: 'ok' | 'err' | 'warn'
}

// Module-level singleton — shared across all callers.
const toasts = ref<ToastItem[]>([])
let nextId = 1

function show(msg: string, type: ToastItem['type'] = 'ok') {
  const id = nextId++
  toasts.value.push({ id, msg, type })
  setTimeout(() => {
    const idx = toasts.value.findIndex((t) => t.id === id)
    if (idx !== -1) toasts.value.splice(idx, 1)
  }, 4000)
}

export function useToast() {
  return { toasts, show }
}
