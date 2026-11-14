<script setup lang="ts">
/**
 * 「AI 服务」选了「本机模型」时的模型列表 (Qwen3.5, 三档): 按设备标出推荐的一档,
 * 下载 (后台进行, 可续传) / 选用 / 删除 / 闪退后的恢复; 带不动的档位给出原因, 不提供下载。
 * 桌面与 App 的设置页共用; 状态全局共享 (services/localLlm.ts)。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { askConfirm } from '../services/confirm'
import { toast } from '../services/toast'
import { clearLocalLlmCrash, downloadLocalModel, localLlm, refreshLocalLlm, removeLocalModel, type LocalModel } from '../services/localLlm'
import { LOCAL_CHAT_SLOW_TPS, chatModels, pickChatModel } from '../services/localChatCore'

const settings = useSettings()
const models = computed(() => chatModels(localLlm.models))
const active = computed(() => pickChatModel(localLlm.models, settings.aiModel))
const busy = ref('')

onMounted(() => void refreshLocalLlm())
// 设置里记着的模型没下载 (换了设备, 或刚选「本机模型」): 改记实际会用的那个
watch(active, m => {
  if (m && settings.aiModel !== m.id) settings.aiModel = m.id
}, { immediate: true })

const mb = (n: number) => Math.round(n / 1048576)
const sizeText = (m: LocalModel) => (m.size >= 1073741824 ? `${(m.size / 1073741824).toFixed(1)} GB` : `${mb(m.size)} MB`)
const percent = (m: LocalModel) => (m.size ? Math.min(100, Math.floor((m.downloaded / m.size) * 100)) : 0)
/** 模型编号 qwen3.5-2b-q4 → 文案键 localChat.tier.2b */
const tierKey = (m: LocalModel) => `localChat.tier.${m.id.split('-')[1] ?? ''}`

function downloadLabel(m: LocalModel): string {
  if (m.running) {
    if (localLlm.phase === 'connecting' && !m.downloaded) return t('common.connecting')
    return t('localModel.progress', { pct: percent(m), done: mb(m.downloaded), total: mb(m.size) })
  }
  return m.downloaded > 0
    ? t('localModel.resume', { done: mb(m.downloaded), total: mb(m.size) })
    : t('localModel.download', { size: sizeText(m) })
}

function speedText(m: LocalModel): string {
  if (m.speed === null) return t('localModel.speedUnknown')
  const how = m.gpu ? t('localModel.onGpu') : t('localModel.onCpu')
  if (m.speed < LOCAL_CHAT_SLOW_TPS) return t('localChat.speedSlow', { how })
  return t(m.speed >= 30 ? 'localModel.speedFast' : 'localModel.speedOk', { how })
}

const anotherRunning = (m: LocalModel) => localLlm.models.some(x => x.running && x.id !== m.id)

async function download(m: LocalModel) {
  try {
    await downloadLocalModel(m.id)
    // 刚下好的就是要用的
    settings.aiModel = m.id
    toast(t('localChat.ready'), 'success')
  } catch (e: any) {
    toast(t('localModel.downloadFailed', { msg: e?.message ?? e }), 'error', 8000)
  }
}

async function remove(m: LocalModel) {
  if (!(await askConfirm(t('localChat.removeConfirm'), { confirmLabel: t('common.delete'), danger: true }))) return
  busy.value = m.id
  try {
    await removeLocalModel(m.id)
  } catch (e: any) {
    toast(e?.message ?? String(e), 'error')
  } finally {
    busy.value = ''
  }
}

async function retry(m: LocalModel) {
  try {
    await clearLocalLlmCrash(m.id)
  } catch (e: any) {
    toast(e?.message ?? String(e), 'error')
  }
}
</script>

<template>
  <div class="chat-models">
    <p class="cm-note">{{ t('localChat.desc') }}</p>
    <p v-if="localLlm.loaded && !models.length" class="cm-note danger">{{ t('localChat.unavailable') }}</p>
    <ul class="cm-list">
      <li v-for="m in models" :key="m.id" class="cm-item" :class="{ active: active?.id === m.id }" :data-model="m.id">
        <div class="cm-head">
          <span class="cm-name">{{ t(`${tierKey(m)}`) }}</span>
          <span v-if="m.recommended" class="cm-chip brand">{{ t('localChat.recommended') }}</span>
          <span v-if="active?.id === m.id" class="cm-chip">{{ t('localChat.inUse') }}</span>
          <span class="cm-size">{{ sizeText(m) }}</span>
        </div>
        <p class="cm-note">{{ t(`${tierKey(m)}Desc`) }}</p>
        <template v-if="m.installed">
          <p v-if="m.crashed" class="cm-note danger">{{ t('localChat.crashed') }}</p>
          <p v-else class="cm-note">{{ speedText(m) }}</p>
          <div class="cm-actions">
            <button v-if="m.crashed" class="btn btn-sm" @click="retry(m)">{{ t('localModel.retry') }}</button>
            <button v-else-if="active?.id !== m.id" class="btn btn-sm" @click="settings.aiModel = m.id">{{ t('localChat.use') }}</button>
            <button class="btn btn-sm" :disabled="busy === m.id" @click="remove(m)">{{ t('localModel.remove') }}</button>
          </div>
        </template>
        <p v-else-if="!m.supported" class="cm-note danger">{{ t('localChat.unsupported', { reasons: m.reasons.join('; ') }) }}</p>
        <template v-else>
          <div class="cm-actions">
            <button class="btn btn-sm" :class="{ 'btn-primary': m.recommended }" :disabled="m.running || anotherRunning(m)" @click="download(m)">{{ downloadLabel(m) }}</button>
          </div>
          <span v-if="m.running" class="cm-bar" role="progressbar" :aria-valuenow="percent(m)" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: percent(m) + '%' }" /></span>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.chat-models {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}
.cm-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.cm-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.cm-item.active {
  border-color: var(--brand);
}
.cm-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.cm-name {
  color: var(--text);
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
}
.cm-size {
  margin-left: auto;
  color: var(--text-3);
  font-size: var(--fs-caption);
  font-variant-numeric: tabular-nums;
}
.cm-chip {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-caption);
}
.cm-chip.brand {
  background: var(--brand-light);
  color: var(--brand);
}
.cm-note {
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-small);
  line-height: 1.6;
}
.cm-note.danger {
  color: var(--danger);
}
.cm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.cm-actions .btn {
  font-variant-numeric: tabular-nums;
}
@media (pointer: coarse) {
  .cm-actions .btn {
    min-height: 44px;
  }
}
.cm-bar {
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  overflow: hidden;
}
.cm-bar i {
  display: block;
  height: 100%;
  background: var(--brand);
}
</style>
