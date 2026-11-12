<script setup lang="ts">
/**
 * 本机翻译模型: 设备评估 / 下载 (后台进行, 可续传) / 开关 / 删除 / 闪退后的恢复。
 * 状态全局共享 (services/localLlm.ts), 设置页与翻译面板共用; 这个版本不带引擎时什么都不显示。
 * compact: 翻译面板里的精简形态 —— 只在「还没下载」时出现, 不放开关和删除。
 */
import { computed, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { askConfirm } from '../services/confirm'
import { toast } from '../services/toast'
import { clearLocalLlmCrash, downloadLocalModel, localLlm, localModel, refreshLocalLlm, removeLocalModel } from '../services/localLlm'
import { LOCAL_TRANSLATE_MODEL, LOCAL_TRANSLATE_SLOW_TPS } from '../services/translateCore'

const props = defineProps<{ compact?: boolean }>()
const emit = defineEmits<{ ready: [] }>()
const settings = useSettings()
const model = computed(() => (localLlm.available ? localModel(LOCAL_TRANSLATE_MODEL) : undefined))
const removing = ref(false)

onMounted(() => void refreshLocalLlm())

const mb = (n: number) => Math.round(n / 1048576)
const sizeText = computed(() => {
  const gb = (model.value?.size ?? 0) / 1073741824
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${mb(model.value?.size ?? 0)} MB`
})
const percent = computed(() => {
  const m = model.value
  return m?.size ? Math.min(100, Math.floor((m.downloaded / m.size) * 100)) : 0
})
const downloadLabel = computed(() => {
  const m = model.value
  if (!m) return ''
  if (m.running) {
    if (localLlm.phase === 'connecting' && !m.downloaded) return t('common.connecting')
    return t('localModel.progress', { pct: percent.value, done: mb(m.downloaded), total: mb(m.size) })
  }
  return m.downloaded > 0
    ? t('localModel.resume', { done: mb(m.downloaded), total: mb(m.size) })
    : t('localModel.download', { size: sizeText.value })
})
/** 实测速度说成人话 (token/秒对用户没有意义) */
const speedText = computed(() => {
  const m = model.value
  if (!m || m.tokensPerSecond === null) return t('localModel.speedUnknown')
  const how = m.gpu ? t('localModel.onGpu') : t('localModel.onCpu')
  if (m.tokensPerSecond < LOCAL_TRANSLATE_SLOW_TPS) return t('localModel.speedSlow', { how })
  return t(m.tokensPerSecond >= 30 ? 'localModel.speedFast' : 'localModel.speedOk', { how })
})
/** 精简形态只负责「邀请下载」: 装好或带不动时不占翻译面板的地方 */
const visible = computed(() => {
  const m = model.value
  if (!m) return false
  return props.compact ? !m.installed && m.supported : true
})

async function download() {
  try {
    await downloadLocalModel(LOCAL_TRANSLATE_MODEL)
    toast(t('localModel.ready'), 'success')
    emit('ready')
  } catch (e: any) {
    toast(t('localModel.downloadFailed', { msg: e?.message ?? e }), 'error', 8000)
  }
}

async function remove() {
  if (!(await askConfirm(t('localModel.removeConfirm'), { confirmLabel: t('common.delete'), danger: true }))) return
  removing.value = true
  try {
    await removeLocalModel(LOCAL_TRANSLATE_MODEL)
  } catch (e: any) {
    toast(e?.message ?? String(e), 'error')
  } finally {
    removing.value = false
  }
}

async function retry() {
  try {
    await clearLocalLlmCrash(LOCAL_TRANSLATE_MODEL)
  } catch (e: any) {
    toast(e?.message ?? String(e), 'error')
  }
}
</script>

<template>
  <div v-if="visible && model" class="model-pack" :class="{ compact }">
    <div v-if="!compact" class="mp-head">
      <span class="mp-title">{{ t('localModel.translateTitle') }}</span>
      <label v-if="model.installed && !model.crashed" class="mp-switch" :title="t('localModel.use')">
        <input v-model="settings.localTranslate" type="checkbox" role="switch" :aria-label="t('localModel.use')" :aria-checked="settings.localTranslate" />
        <span class="mp-switch-track" aria-hidden="true"></span>
      </label>
    </div>
    <p class="mp-note">{{ compact ? t('localModel.offer', { size: sizeText }) : t('localModel.translateDesc', { size: sizeText }) }}</p>

    <template v-if="model.installed">
      <template v-if="model.crashed">
        <p class="mp-note danger">{{ t('localModel.crashed') }}</p>
        <div class="mp-actions">
          <button class="btn btn-sm" @click="retry">{{ t('localModel.retry') }}</button>
          <button class="btn btn-sm" :disabled="removing" @click="remove">{{ t('localModel.remove') }}</button>
        </div>
      </template>
      <template v-else>
        <p class="mp-note">{{ t('localModel.installed', { size: sizeText }) }} · {{ speedText }}</p>
        <div class="mp-actions">
          <button class="btn btn-sm" :disabled="removing" @click="remove">{{ t('localModel.remove') }}</button>
        </div>
      </template>
    </template>
    <template v-else>
      <p v-if="!model.supported" class="mp-note danger">{{ t('localModel.unsupported', { reasons: model.reasons.join('; ') }) }}</p>
      <template v-else>
        <div class="mp-actions">
          <button class="btn btn-sm" :class="{ 'btn-primary': !compact }" :disabled="model.running" @click="download">{{ downloadLabel }}</button>
        </div>
        <span
          v-if="model.running"
          class="mp-bar"
          role="progressbar"
          :aria-valuenow="percent"
          aria-valuemin="0"
          aria-valuemax="100"
        ><i :style="{ width: percent + '%' }" /></span>
      </template>
    </template>
  </div>
</template>

<style scoped>
.model-pack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}
.model-pack.compact {
  margin-top: 0;
  padding-top: var(--space-3);
}
.mp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.mp-title {
  color: var(--text);
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
}
.mp-note {
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-small);
  line-height: 1.6;
}
.compact .mp-note {
  color: var(--text-3);
  font-size: var(--fs-caption);
}
.mp-note.danger {
  color: var(--danger);
}
.mp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.mp-actions .btn {
  font-variant-numeric: tabular-nums;
}
@media (pointer: coarse) {
  .mp-actions .btn {
    min-height: 44px;
  }
}
.mp-bar {
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  overflow: hidden;
}
.mp-bar i {
  display: block;
  height: 100%;
  background: var(--brand);
  transition: width 0.3s ease;
}
.mp-switch {
  position: relative;
  width: 40px;
  height: 24px;
  flex-shrink: 0;
}
.mp-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
.mp-switch-track {
  position: absolute;
  inset: 0;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}
.mp-switch-track::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--on-brand);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease);
}
.mp-switch input:checked + .mp-switch-track {
  background: var(--brand);
}
.mp-switch input:checked + .mp-switch-track::after {
  transform: translateX(16px);
}
.mp-switch input:focus-visible + .mp-switch-track {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .mp-bar i,
  .mp-switch-track,
  .mp-switch-track::after {
    transition: none;
  }
}
</style>
