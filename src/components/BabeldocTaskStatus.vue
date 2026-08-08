<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../i18n'
import { BABELDOC_STARTING_LINE, stageLabel } from '../services/babeldoc'
import {
  babeldocTask,
  cancelBabeldocTask,
  dismissBabeldocTaskError,
} from '../services/babeldocTask'

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

function stopTimer() {
  clearInterval(timer)
  timer = undefined
}

const stopPhaseWatch = watch(
  () => babeldocTask.phase,
  phase => {
    if (phase === 'running' || phase === 'cancelling' || phase === 'importing') {
      now.value = Date.now()
      timer ??= setInterval(() => {
        now.value = Date.now()
      }, 1000)
    } else {
      stopTimer()
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  stopPhaseWatch()
  stopTimer()
})

const elapsed = computed(() => {
  if (!babeldocTask.startedAt) return '0:00'
  const seconds = Math.max(0, Math.floor((now.value - babeldocTask.startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
})

const statusText = computed(() => {
  if (babeldocTask.phase === 'cancelling') return t('paper.bdCancelling')
  if (babeldocTask.phase === 'importing') return t('paper.bdImporting')
  if (babeldocTask.stage) {
    const count = babeldocTask.total && babeldocTask.total > 1
      ? ` ${babeldocTask.current ?? 0}/${babeldocTask.total}`
      : ''
    return stageLabel(babeldocTask.stage) + count
  }
  if (!babeldocTask.line || babeldocTask.line === BABELDOC_STARTING_LINE) return t('paper.bdStarting')
  return babeldocTask.line
})
</script>

<template>
  <aside
    v-if="babeldocTask.phase !== 'idle'"
    class="bd-task"
    :class="{ 'is-error': babeldocTask.phase === 'error' }"
    role="status"
    aria-live="polite"
  >
    <div class="bd-task-head">
      <div>
        <strong>{{ t('paper.bdBackgroundTitle') }}</strong>
        <span>{{ babeldocTask.sourceTitle }}</span>
      </div>
      <button
        v-if="babeldocTask.phase === 'error'"
        class="bd-task-close"
        :aria-label="t('common.close')"
        @click="dismissBabeldocTaskError"
      >×</button>
    </div>

    <template v-if="babeldocTask.phase === 'error'">
      <p class="bd-task-error">{{ babeldocTask.error }}</p>
    </template>
    <template v-else>
      <div class="bd-task-bar" :class="{ indeterminate: babeldocTask.percent == null }">
        <div :style="babeldocTask.percent != null ? { width: `${babeldocTask.percent}%` } : {}" />
      </div>
      <p>
        <span>{{ babeldocTask.percent != null ? `${babeldocTask.percent.toFixed(0)}% · ` : '' }}{{ statusText }}</span>
        <small>{{ t('paper.bdElapsed') }} {{ elapsed }}</small>
      </p>
      <button
        v-if="babeldocTask.phase !== 'importing'"
        class="bd-task-cancel"
        :disabled="babeldocTask.phase === 'cancelling'"
        @click="cancelBabeldocTask"
      >{{ t('paper.bdCancel') }}</button>
    </template>
  </aside>
</template>

<style scoped>
.bd-task {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 90;
  width: min(360px, calc(100vw - 36px));
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card);
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.18);
}
.bd-task-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.bd-task-head > div {
  min-width: 0;
}
.bd-task-head strong,
.bd-task-head span {
  display: block;
}
.bd-task-head strong {
  font-size: 13px;
}
.bd-task-head span {
  margin-top: 2px;
  overflow: hidden;
  color: var(--text-3);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bd-task-bar {
  height: 5px;
  margin: 12px 0 9px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--bg);
}
.bd-task-bar > div {
  height: 100%;
  border-radius: inherit;
  background: var(--brand);
  transition: width 0.35s;
}
.bd-task-bar.indeterminate > div {
  width: 32%;
  animation: bd-task-slide 1.2s ease-in-out infinite;
}
.bd-task p {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin: 0;
  color: var(--text-2);
  font-size: 12px;
}
.bd-task p span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bd-task p small {
  flex: none;
  color: var(--text-3);
}
.bd-task-cancel {
  margin-top: 10px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 12px;
}
.bd-task-cancel:hover {
  color: var(--danger, #d54941);
}
.bd-task-cancel:disabled {
  cursor: default;
  opacity: 0.55;
}
.bd-task-close {
  padding: 0 2px;
  border: 0;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
}
.bd-task.is-error {
  border-color: color-mix(in srgb, var(--danger, #d54941) 35%, var(--border));
}
.bd-task .bd-task-error {
  display: block;
  margin-top: 10px;
  color: var(--danger, #d54941);
  line-height: 1.5;
  white-space: normal;
  word-break: break-word;
}
@keyframes bd-task-slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(320%); }
}
</style>
