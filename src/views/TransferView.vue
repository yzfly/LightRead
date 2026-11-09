<script setup lang="ts">
import AppSelect from '../components/AppSelect.vue'
/**
 * 互传: 在自己的设备间发送文字 / 链接 / 文件 (轻阅账号或 WebDAV), 或用取件码临时传给任何设备.
 * 设计见 docs/device-transfer.md. 深链 #/transfer?code=123456 直接取件.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { accountApiBase, accountState } from '../services/account'
import { useSettings } from '../stores/settings'
import TransferItemCard from '../components/TransferItemCard.vue'
import {
  copyText, deviceChannelsAvailable, loadDevices, lookupDrop, refreshTransfers, sendTransfer, transferState, webAppBase,
  type DeviceChannelId,
} from '../services/transfer'
import { codeFromLink, composeInput, dropShareLink, durationText, formatBytes, validateSend } from '../services/transfer/model'
import { DROP_TTLS, LIMITS, type TransferItem } from '../services/transfer/types'
import { encodeQr, qrPath } from '../services/qr'

const route = useRoute()
const router = useRouter()
const settings = useSettings()

const initialCode = typeof route.query.code === 'string' ? codeFromLink(route.query.code) : null
/** 设置 → 功能 里关闭互传时: 只显示说明与「开启互传」, 不收取、不联网 */
const enabled = computed(() => settings.features.transfer)
const tab = ref<'devices' | 'drop'>(initialCode ? 'drop' : 'devices')

// ---- 我的设备 ----

// 依赖登录状态与 WebDAV 配置 (都是响应式的)
const channels = computed<DeviceChannelId[]>(() => {
  void accountState.token
  void settings.webdavUrl
  void settings.webdavUser
  void settings.webdavPass
  return deviceChannelsAvailable()
})
const via = ref<DeviceChannelId>(channels.value[0] ?? 'account')
watch(channels, list => {
  if (list.length && !list.includes(via.value)) via.value = list[0]
  if (!enabled.value) return
  for (const id of list) void loadDevices(id)
  void refreshTransfers()
})
const target = ref('')
watch(via, () => { target.value = '' })
const devices = computed(() => transferState.devices[via.value] ?? [])

const deviceItems = computed(() => transferState.items.filter(it => it.channel !== 'drop' && channels.value.includes(it.channel as DeviceChannelId)))
const dropItems = computed(() => transferState.items.filter(it => it.channel === 'drop'))
const channelErrors = computed(() => channels.value
  .map(id => transferState.errors[id])
  .filter((e): e is string => !!e))

interface Draft {
  text: string
  file: File | null
  sending: boolean
  /** undefined: 没在发; null: 不确定进度 */
  progress: number | null | undefined
}
const newDraft = (): Draft => ({ text: '', file: null, sending: false, progress: undefined })
const draft = ref<Draft>(newDraft())
const dropDraft = ref<Draft>(newDraft())
const deviceFileInput = ref<HTMLInputElement>()
const dropFileInput = ref<HTMLInputElement>()

function pickFile(d: Draft, e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) d.file = file
  input.value = ''
}
function onDropFile(d: Draft, e: DragEvent) {
  const file = e.dataTransfer?.files?.[0]
  if (file) d.file = file
}

const progressLabel = (p: number | null | undefined) =>
  p == null ? t('transfer.sendingUnknown') : t('transfer.sendingPct', { pct: Math.round(p * 100) })

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function sendToDevices() {
  const d = draft.value
  const input = composeInput(d.text, d.file ? { blob: d.file, name: d.file.name } : null)
  if (!input || d.sending) return
  const invalid = validateSend(input)
  if (invalid) return toast(t(invalid.key, invalid.params), 'error', 5000)
  d.sending = true
  d.progress = input.kind === 'file' ? 0 : null
  try {
    await sendTransfer(via.value, { ...input, toDevice: target.value || null }, p => { d.progress = p })
    draft.value = newDraft()
    toast(t('transfer.sent'), 'success')
  } catch (e) {
    toast(t('transfer.sendFailed', { msg: errMsg(e) }), 'error', 6000)
  } finally {
    d.sending = false
    d.progress = undefined
  }
}

function onComposerKey(e: KeyboardEvent, send: () => void) {
  // Ctrl / Cmd + Enter 发送 (单独 Enter 换行)
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    send()
  }
}

function goLogin() {
  router.push('/settings').then(() => {
    setTimeout(() => document.getElementById('settings-sync')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250)
  })
}

// ---- 取件码 ----

const ttl = ref<number>(DROP_TTLS[1])
const lastDrop = ref<TransferItem | null>(null)
const dropMax = computed(() => (accountState.token ? LIMITS.dropAuthBytes : LIMITS.dropAnonBytes))

async function createDrop() {
  const d = dropDraft.value
  const input = composeInput(d.text, d.file ? { blob: d.file, name: d.file.name } : null)
  if (!input || d.sending) return
  const invalid = validateSend(input, dropMax.value)
  if (invalid) return toast(t(invalid.key, invalid.params), 'error', 5000)
  d.sending = true
  d.progress = input.kind === 'file' ? 0 : null
  try {
    lastDrop.value = await sendTransfer('drop', { ...input, ttlMs: ttl.value }, p => { d.progress = p })
    dropDraft.value = newDraft()
  } catch (e) {
    toast(t('transfer.sendFailed', { msg: errMsg(e) }), 'error', 6000)
  } finally {
    d.sending = false
    d.progress = undefined
  }
}

const shareLink = computed(() => lastDrop.value?.code
  ? dropShareLink(lastDrop.value.code, accountApiBase(), webAppBase())
  : '')
const qr = computed(() => {
  if (!shareLink.value) return null
  try {
    return qrPath(encodeQr(shareLink.value, 'M'), 4)
  } catch {
    return null
  }
})
const lastDropValid = computed(() => lastDrop.value
  ? t('transfer.dropValid', {
    time: durationText(lastDrop.value.expiresAt - Date.now(), t),
    n: lastDrop.value.downloadsLeft ?? 10,
  })
  : '')

const codeInput = ref(initialCode ?? '')
const looking = ref(false)
async function pickUp() {
  const code = codeFromLink(codeInput.value)
  if (!code) return toast(t('transfer.err.badCode'), 'error')
  looking.value = true
  try {
    await lookupDrop(code)
    codeInput.value = ''
  } catch (e) {
    toast(errMsg(e), 'error', 6000)
  } finally {
    looking.value = false
  }
}

async function copy(text: string) {
  try {
    await copyText(text)
    toast(t('transfer.copied'), 'success')
  } catch (e) {
    toast(errMsg(e), 'error')
  }
}

// ---- 生命周期 ----

function start() {
  transferState.unread = 0
  void refreshTransfers()
  for (const id of channels.value) void loadDevices(id)
  if (initialCode) void pickUp()
}
onMounted(() => {
  transferState.pageOpen = true
  if (enabled.value) start()
})
// 在本页点「开启互传」后立即开始 (深链取件码随之取件)
watch(enabled, on => { if (on) start() })
onBeforeUnmount(() => {
  transferState.pageOpen = false
})
</script>

<template>
  <div class="transfer">
    <header class="page-head">
      <div class="head-text">
        <h1>{{ t('transfer.title') }}</h1>
        <p class="subtitle">{{ t('transfer.subtitle') }}</p>
      </div>
      <button
        v-if="enabled"
        type="button"
        class="btn btn-ghost btn-icon refresh"
        :title="t('transfer.refresh')"
        :aria-label="t('transfer.refresh')"
        :disabled="transferState.loading"
        @click="refreshTransfers"
      >
        <svg :class="{ spinning: transferState.loading }" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2" /><path d="M18.5 2.5v3.7h-3.7M5.5 21.5v-3.7h3.7" /></svg>
      </button>
    </header>

    <!-- 互传未开启 -->
    <div v-if="!enabled" class="card setup empty">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M16.3 3.3a1 1 0 0 1 1.4 0l3 3a1 1 0 0 1 0 1.4l-3 3a1 1 0 1 1-1.4-1.4L17.58 8H5a1 1 0 0 1 0-2h12.59l-1.3-1.3a1 1 0 0 1 0-1.4zM7.7 13.3a1 1 0 0 1 0 1.4L6.42 16H19a1 1 0 1 1 0 2H6.41l1.3 1.3a1 1 0 1 1-1.42 1.4l-3-3a1 1 0 0 1 0-1.4l3-3a1 1 0 0 1 1.42 0z" /></svg>
      </div>
      <p class="empty-title">{{ t('transfer.disabledTitle') }}</p>
      <p class="setup-desc">{{ t('transfer.disabledDesc') }}</p>
      <div class="empty-actions">
        <button type="button" class="btn btn-primary" @click="settings.features.transfer = true">{{ t('transfer.enable') }}</button>
      </div>
    </div>

    <template v-else>
    <div class="segmented tabs" role="group" :aria-label="t('transfer.title')">
      <button type="button" :class="{ active: tab === 'devices' }" :aria-pressed="tab === 'devices'" @click="tab = 'devices'">{{ t('transfer.tabDevices') }}</button>
      <button type="button" :class="{ active: tab === 'drop' }" :aria-pressed="tab === 'drop'" @click="tab = 'drop'">{{ t('transfer.tabDrop') }}</button>
    </div>

    <!-- 我的设备 -->
    <section v-if="tab === 'devices'" class="pane">
      <div v-if="!channels.length" class="card setup empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="11" height="8" rx="1.5" /><rect x="15" y="9" width="6" height="11" rx="1.5" /><path d="M6 16h6M9 12v4M7 20h5" /></svg>
        </div>
        <p class="empty-title">{{ t('transfer.setupTitle') }}</p>
        <p class="setup-desc">{{ t('transfer.setupDesc') }}</p>
        <div class="empty-actions">
          <button type="button" class="btn btn-primary" @click="goLogin">{{ t('transfer.goLogin') }}</button>
          <button type="button" class="btn" @click="tab = 'drop'">{{ t('transfer.useDrop') }}</button>
        </div>
      </div>

      <template v-else>
        <div class="card composer" @dragover.prevent @drop.prevent="onDropFile(draft, $event)">
          <textarea
            v-model="draft.text"
            class="input composer-text"
            rows="3"
            :placeholder="draft.file ? t('transfer.notePlaceholder') : t('transfer.placeholder')"
            :aria-label="t('transfer.composerLabel')"
            :disabled="draft.sending"
            @keydown="onComposerKey($event, sendToDevices)"
          />
          <div v-if="draft.file" class="file-chip">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
            <span class="file-chip-name">{{ draft.file.name }}</span>
            <span class="file-chip-size">{{ formatBytes(draft.file.size) }}</span>
            <button type="button" class="chip-x" :title="t('transfer.removeFile')" :aria-label="t('transfer.removeFile')" :disabled="draft.sending" @click="draft.file = null">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3z" /></svg>
            </button>
          </div>
          <div v-if="draft.progress !== undefined" class="send-progress" role="progressbar" :aria-label="progressLabel(draft.progress)"
            aria-valuemin="0" aria-valuemax="100" :aria-valuenow="draft.progress === null ? undefined : Math.round(draft.progress * 100)">
            <span :class="{ indeterminate: draft.progress === null }" :style="draft.progress === null ? undefined : { width: `${Math.round(draft.progress * 100)}%` }" />
          </div>
          <div class="composer-bar">
            <button type="button" class="btn btn-ghost btn-icon attach" :title="t('transfer.attach')" :aria-label="t('transfer.attach')" :disabled="draft.sending" @click="deviceFileInput?.click()">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20.5 11.5-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" /></svg>
            </button>
            <input ref="deviceFileInput" type="file" hidden data-transfer-file @change="pickFile(draft, $event)" />
            <label class="field">
              <span class="field-label">{{ t('transfer.to') }}</span>
              <AppSelect v-model="target" class="input field-select" :disabled="draft.sending" :aria-label="t('transfer.to')">
                <option value="">{{ t('transfer.allDevices') }}</option>
                <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name || d.id.slice(0, 8) }}</option>
              </AppSelect>
            </label>
            <label v-if="channels.length > 1" class="field">
              <span class="field-label">{{ t('transfer.via') }}</span>
              <AppSelect v-model="via" class="input field-select" :disabled="draft.sending" :aria-label="t('transfer.via')">
                <option value="account">{{ t('transfer.viaAccount') }}</option>
                <option value="webdav">{{ t('transfer.viaWebdav') }}</option>
              </AppSelect>
            </label>
            <span class="spacer" />
            <button
              type="button"
              class="btn btn-primary send"
              :disabled="draft.sending || (!draft.text.trim() && !draft.file)"
              @click="sendToDevices"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4z" /></svg>
              {{ draft.sending ? progressLabel(draft.progress) : t('transfer.send') }}
            </button>
          </div>
        </div>
        <p class="privacy">{{ t(via === 'webdav' ? 'transfer.privacyWebdav' : 'transfer.privacy') }}</p>

        <p v-for="e in channelErrors" :key="e" class="pane-error" role="alert">{{ e }}</p>

        <div v-if="deviceItems.length" class="timeline">
          <TransferItemCard
            v-for="it in deviceItems"
            :key="`${it.channel}:${it.id}`"
            :item="it"
            :device-id="transferState.deviceId"
            :devices="transferState.devices[it.channel as DeviceChannelId] ?? []"
            :show-channel="channels.length > 1"
          />
        </div>
        <div v-else-if="!transferState.loading" class="empty list-empty">
          <p class="empty-title">{{ t('transfer.empty') }}</p>
          <p>{{ t('transfer.emptyHint') }}</p>
        </div>
      </template>
    </section>

    <!-- 取件码 -->
    <section v-else class="pane drop-pane">
      <div class="drop-grid" :class="{ 'pickup-first': !!initialCode }">
        <div class="card drop-card" @dragover.prevent @drop.prevent="onDropFile(dropDraft, $event)">
          <h2>{{ t('transfer.dropSendTitle') }}</h2>
          <p class="card-desc">{{ t('transfer.dropSendDesc') }}</p>

          <div v-if="lastDrop && lastDrop.code" class="drop-result">
            <div class="drop-code-block">
              <span class="field-label">{{ t('transfer.dropCode') }}</span>
              <span class="drop-code" aria-live="polite">{{ lastDrop.code.slice(0, 3) }}<span class="code-gap" aria-hidden="true" />{{ lastDrop.code.slice(3) }}</span>
              <span class="drop-valid">{{ lastDropValid }}</span>
              <div class="drop-result-actions">
                <button type="button" class="btn btn-sm" @click="copy(lastDrop.code)">{{ t('transfer.copyCode') }}</button>
                <button type="button" class="btn btn-sm" @click="copy(shareLink)">{{ t('transfer.copyLink') }}</button>
              </div>
            </div>
            <svg v-if="qr" class="qr" :viewBox="`0 0 ${qr.size} ${qr.size}`" role="img" :aria-label="t('transfer.dropQr')" shape-rendering="crispEdges">
              <rect :width="qr.size" :height="qr.size" class="qr-bg" />
              <path :d="qr.d" class="qr-fg" />
            </svg>
            <p class="drop-link" :title="t('transfer.dropLink')">{{ shareLink }}</p>
            <button type="button" class="btn btn-sm btn-ghost drop-again" @click="lastDrop = null">{{ t('transfer.dropCreate') }}</button>
          </div>

          <template v-else>
            <textarea
              v-model="dropDraft.text"
              class="input composer-text"
              rows="3"
              :placeholder="dropDraft.file ? t('transfer.notePlaceholder') : t('transfer.placeholder')"
              :aria-label="t('transfer.composerLabel')"
              :disabled="dropDraft.sending"
              @keydown="onComposerKey($event, createDrop)"
            />
            <div v-if="dropDraft.file" class="file-chip">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
              <span class="file-chip-name">{{ dropDraft.file.name }}</span>
              <span class="file-chip-size">{{ formatBytes(dropDraft.file.size) }}</span>
              <button type="button" class="chip-x" :title="t('transfer.removeFile')" :aria-label="t('transfer.removeFile')" :disabled="dropDraft.sending" @click="dropDraft.file = null">
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3a1 1 0 0 0-1.4 1.4L10.6 12l-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12l5.3-5.3a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3z" /></svg>
              </button>
            </div>
            <div v-if="dropDraft.progress !== undefined" class="send-progress" role="progressbar" :aria-label="progressLabel(dropDraft.progress)"
              aria-valuemin="0" aria-valuemax="100" :aria-valuenow="dropDraft.progress === null ? undefined : Math.round(dropDraft.progress * 100)">
              <span :class="{ indeterminate: dropDraft.progress === null }" :style="dropDraft.progress === null ? undefined : { width: `${Math.round(dropDraft.progress * 100)}%` }" />
            </div>
            <div class="composer-bar">
              <button type="button" class="btn btn-ghost btn-icon attach" :title="t('transfer.attach')" :aria-label="t('transfer.attach')" :disabled="dropDraft.sending" @click="dropFileInput?.click()">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20.5 11.5-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" /></svg>
              </button>
              <input ref="dropFileInput" type="file" hidden data-drop-file @change="pickFile(dropDraft, $event)" />
              <span class="field-label">{{ t('transfer.dropTtl') }}</span>
              <div class="segmented ttl" role="group" :aria-label="t('transfer.dropTtl')">
                <button type="button" :class="{ active: ttl === DROP_TTLS[0] }" :aria-pressed="ttl === DROP_TTLS[0]" @click="ttl = DROP_TTLS[0]">{{ t('transfer.ttl10m') }}</button>
                <button type="button" :class="{ active: ttl === DROP_TTLS[1] }" :aria-pressed="ttl === DROP_TTLS[1]" @click="ttl = DROP_TTLS[1]">{{ t('transfer.ttl1h') }}</button>
              </div>
              <span class="spacer" />
              <button
                type="button"
                class="btn btn-primary send"
                :disabled="dropDraft.sending || (!dropDraft.text.trim() && !dropDraft.file)"
                @click="createDrop"
              >{{ dropDraft.sending ? progressLabel(dropDraft.progress) : t('transfer.dropCreate') }}</button>
            </div>
          </template>
          <p class="privacy">{{ t('transfer.dropWarning', { max: formatBytes(dropMax) }) }}</p>
        </div>

        <form class="card drop-card pickup" @submit.prevent="pickUp">
          <h2>{{ t('transfer.dropReceiveTitle') }}</h2>
          <div class="pickup-row">
            <input
              v-model="codeInput"
              class="input code-input"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="80"
              :placeholder="t('transfer.dropCodePlaceholder')"
              :aria-label="t('transfer.dropCode')"
            />
            <button type="submit" class="btn btn-primary" :disabled="looking || !codeFromLink(codeInput)">{{ t('transfer.dropFetch') }}</button>
          </div>
        </form>
      </div>

      <template v-if="dropItems.length">
        <h3 class="list-head">{{ t('transfer.dropList') }} <span>{{ t('transfer.dropListHint') }}</span></h3>
        <div class="timeline">
          <TransferItemCard
            v-for="it in dropItems"
            :key="`drop:${it.id}`"
            :item="it"
            :device-id="transferState.deviceId"
            :devices="[]"
          />
        </div>
      </template>
    </section>
    </template>
  </div>
</template>

<style scoped>
.transfer {
  /* 共享给 App: App 样式表没有 --page-max-narrow, 回退到原宽度 */
  max-width: calc(var(--page-max-narrow, 772px) + 2 * var(--page-x));
  margin: 0 auto;
  padding: var(--page-top) var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
}
.page-head {
  display: flex;
  /* Windows 自绘窗口按钮在右上角, 标题行右侧让开 (--chrome-inset-right, styles/main.css) */
  padding-right: var(--chrome-inset-right);
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
h1 {
  font-size: var(--page-title);
  font-weight: 700;
  letter-spacing: -0.015em;
}
.subtitle {
  margin-top: 4px;
  font-size: 13px;
  color: var(--text-3);
  max-width: 60ch;
}
.refresh {
  color: var(--text-2);
}
.spinning {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.tabs {
  margin-bottom: 16px;
}
.pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.setup {
  padding: 40px 24px;
}
.setup-desc {
  max-width: 44ch;
  line-height: 1.6;
}
.composer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}
.composer-text {
  width: 100%;
  height: auto;
  min-height: 76px;
  padding: 10px 12px;
  resize: vertical;
  font: inherit;
  font-size: 14px;
  line-height: 1.6;
}
.file-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 6px 6px 10px;
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
}
.file-chip-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-weight: 500;
}
.file-chip-size {
  flex-shrink: 0;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.chip-x {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-3);
}
.chip-x:hover {
  background: var(--surface-3);
  color: var(--text);
}
.send-progress {
  position: relative;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  overflow: hidden;
}
.send-progress span {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--brand);
  border-radius: inherit;
  transition: width var(--dur) var(--ease);
}
.send-progress span.indeterminate {
  width: 35%;
  animation: slide 1.2s var(--ease) infinite;
}
@keyframes slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}
.composer-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.attach {
  color: var(--text-2);
}
.field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.field-label {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
.field-select {
  height: var(--control-h-sm);
  max-width: 190px;
  padding: 0 8px;
  font-size: 13px;
}
.spacer {
  flex: 1;
}
.send {
  min-width: 88px;
}
.privacy {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.pane-error {
  padding: 8px 12px;
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 13px;
}
.timeline {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.list-empty {
  padding: 40px 20px;
}
.list-empty p:last-child {
  max-width: 40ch;
  line-height: 1.6;
}

/* ---- 取件码 ---- */
.drop-grid {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 12px;
  align-items: start;
}
.drop-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
}
.drop-card h2 {
  font-size: 15px;
  font-weight: 650;
}
.card-desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
.ttl button {
  height: 26px;
  padding: 0 10px;
}
.pickup-row {
  display: flex;
  gap: 8px;
}
.code-input {
  flex: 1;
  min-width: 0;
  font-size: 16px;
  letter-spacing: 0.12em;
  font-variant-numeric: tabular-nums;
}
.drop-result {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 16px;
  align-items: center;
}
.drop-code-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.drop-code {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.code-gap {
  display: inline-block;
  width: 0.35em;
}
.drop-valid {
  font-size: 12px;
  color: var(--text-3);
}
.drop-result-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.qr {
  width: 132px;
  height: 132px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}
.qr-bg {
  fill: var(--qr-bg);
}
.qr-fg {
  fill: var(--qr-fg);
}
.drop-link {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--text-3);
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
}
.drop-again {
  grid-column: 1 / -1;
  justify-self: start;
}
.list-head {
  margin-top: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.list-head span {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}

@media (max-width: 720px) {
  .drop-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  /* 经取件链接打开: 取件在前 */
  .pickup-first .pickup {
    order: -1;
  }
  .field-select {
    max-width: 150px;
  }
}
@media (max-width: 600px) {
  .drop-result {
    grid-template-columns: minmax(0, 1fr);
    justify-items: start;
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning,
  .send-progress span.indeterminate {
    animation: none;
  }
}
</style>
