<script setup lang="ts">
import { toasts } from '../services/toast'

const ICONS: Record<string, string> = {
  info: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 6a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1zm0-3.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z',
  success: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm4.2 5.3a1 1 0 0 1 0 1.4l-4.9 4.9a1 1 0 0 1-1.4 0l-2.1-2.1a1 1 0 1 1 1.4-1.4l1.4 1.4 4.2-4.2a1 1 0 0 1 1.4 0z',
  error: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 3a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm0 8.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z',
}
</script>

<template>
  <div class="toast-wrap" aria-live="polite" aria-atomic="false">
    <div v-for="item in toasts" :key="item.id" class="toast" :class="item.type" :role="item.type === 'error' ? 'alert' : 'status'">
      <svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true"><path :d="ICONS[item.type] ?? ICONS.info" fill="currentColor" /></svg>
      <span>{{ item.message }}</span>
    </div>
  </div>
</template>
