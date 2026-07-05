import { reactive } from 'vue'

export interface Toast {
  id: number
  message: string
  type: 'info' | 'success' | 'error'
}

export const toasts = reactive<Toast[]>([])

let nextId = 1

export function toast(message: string, type: Toast['type'] = 'info', duration = 2600) {
  const item: Toast = { id: nextId++, message, type }
  toasts.push(item)
  setTimeout(() => {
    const i = toasts.findIndex(t => t.id === item.id)
    if (i >= 0) toasts.splice(i, 1)
  }, duration)
}
