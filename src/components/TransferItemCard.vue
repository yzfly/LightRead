<script setup lang="ts">
import { askConfirm, deleteConfirmOptions } from '../services/confirm'
/** 互传页的一条记录: 文字 / 链接 / 文件, 带复制、打开、导入、下载、删除 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { toast } from '../services/toast'
import { detectFormat } from '../services/format'
import { detectReadableFormat } from '../services/plainText'
import { readerPath } from '../services/readerRoute'
import {
  copyText, importTransferFile, openExternalLink, removeTransfer, saveTextToLibrary, saveTransferFile,
} from '../services/transfer'
import { formatBytes, isOutgoing, relativeTime, durationText } from '../services/transfer/model'
import type { TransferDevice, TransferItem } from '../services/transfer/types'

const props = defineProps<{
  item: TransferItem
  deviceId: string
  devices: TransferDevice[]
  /** 显示通道标签 (同时用账号和 WebDAV 时) */
  showChannel?: boolean
}>()

const router = useRouter()
const settings = useSettings()
const busy = ref(false)
/** undefined: 无进度条; null: 不确定进度 */
const progress = ref<number | null | undefined>(undefined)
const expanded = ref(false)

const outgoing = computed(() => isOutgoing(props.item, props.deviceId))
const now = Date.now()
const locale = computed(() => (settings.language === 'en' ? 'en-US' : 'zh-CN'))
const expired = computed(() => props.item.expiresAt <= Date.now())

const headline = computed(() => {
  const it = props.item
  if (it.channel === 'drop') return t('transfer.dropReceived', { code: it.code ?? '' })
  if (outgoing.value) {
    const name = it.toDevice === null
      ? t('transfer.allDevices')
      : props.devices.find(d => d.id === it.toDevice)?.name || t('transfer.unknownDevice')
    return t('transfer.toTarget', { name })
  }
  return t('transfer.from', { name: it.fromName || t('transfer.unknownDevice') })
})
const timeText = computed(() => relativeTime(props.item.createdAt, now, t, locale.value))
const expiryText = computed(() => {
  const it = props.item
  if (it.channel !== 'drop') return ''
  if (expired.value) return t('transfer.expired')
  return t('transfer.expiresIn', { time: durationText(it.expiresAt - Date.now(), t) })
})

const isLong = computed(() => {
  const text = props.item.text ?? ''
  return text.length > 360 || text.split('\n').length > 8
})

/** 链接指向的是书 (按路径扩展名判断), 才提供「下载入库」 */
const linkIsBook = computed(() => {
  const url = props.item.url
  if (!url) return false
  try {
    return !!detectFormat(decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''))
  } catch {
    return false
  }
})
const fileIsBook = computed(() => !!detectReadableFormat(props.item.filename ?? ''))
const fileAvailable = computed(() => props.item.kind === 'file' && !(props.item.channel === 'drop' && expired.value))

const progressText = computed(() => {
  if (progress.value === undefined) return ''
  return progress.value === null ? t('transfer.sendingUnknown') : t('transfer.downloading', { pct: `${Math.round(progress.value * 100)}%` })
})

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  try {
    await fn()
  } catch (e) {
    toast(errMsg(e), 'error', 6000)
  } finally {
    busy.value = false
    progress.value = undefined
  }
}

const copy = (text: string) => run(async () => {
  await copyText(text)
  toast(t('transfer.copied'), 'success')
})

const saveTxt = () => run(async () => {
  const book = await saveTextToLibrary(props.item)
  toast(t('transfer.savedToLibrary'), 'success', 6000, {
    label: t('transfer.openLink'),
    run: () => router.push(readerPath(book)),
  })
})

const openLink = () => run(() => openExternalLink(props.item.url!))

const importLink = () => run(async () => {
  progress.value = null
  const { importFromUrl } = await import('../services/urlImport')
  const res = await importFromUrl(props.item.url!, p => { progress.value = p.fraction })
  if (!res.ok || !res.bookId) throw new Error(res.error ?? t('common.unknownError'))
  const { useLibrary } = await import('../stores/library')
  await useLibrary().refresh()
  const book = useLibrary().books.find(b => b.id === res.bookId)
  toast(t('transfer.imported', { title: book?.title ?? res.fileName }), 'success', 6000, book && {
    label: t('transfer.openLink'),
    run: () => router.push(readerPath(book)),
  })
})

const importOpen = () => run(async () => {
  progress.value = 0
  const book = await importTransferFile(props.item, p => { progress.value = p })
  toast(t('transfer.imported', { title: props.item.title || props.item.filename || '' }), 'success')
  await router.push(readerPath(book))
})

const download = () => run(async () => {
  progress.value = 0
  await saveTransferFile(props.item, p => { progress.value = p })
})

const remove = async () => {
  const forgetOnly = props.item.channel === 'drop' && !props.item.ownerToken
  if (!(await askConfirm(t(forgetOnly ? 'transfer.forgetConfirm' : 'transfer.deleteConfirm'), forgetOnly ? {} : deleteConfirmOptions()))) return
  return run(async () => {
    await removeTransfer(props.item)
    toast(t('transfer.deleted'), 'success')
  })
}
</script>

<template>
  <article class="xfer-item" :class="{ out: outgoing }" :data-kind="item.kind">
    <header class="xfer-meta">
      <span class="xfer-dir" aria-hidden="true">
        <svg v-if="outgoing" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>
        <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7 7 17M15 17H7V9" /></svg>
      </span>
      <span class="xfer-who">{{ headline }}</span>
      <span v-if="showChannel && item.channel === 'webdav'" class="tag xfer-chan">{{ t('transfer.channelWebdav') }}</span>
      <span class="xfer-time">{{ timeText }}</span>
    </header>

    <div class="xfer-body">
      <template v-if="item.kind === 'text'">
        <p v-if="item.title" class="xfer-title">{{ item.title }}</p>
        <p class="xfer-text" :class="{ clamp: isLong && !expanded }">{{ item.text }}</p>
        <button v-if="isLong" type="button" class="xfer-more" :aria-expanded="expanded" @click="expanded = !expanded">
          {{ expanded ? t('transfer.showLess') : t('transfer.showMore') }}
        </button>
      </template>
      <template v-else-if="item.kind === 'link'">
        <p v-if="item.title && item.title !== item.url" class="xfer-title">{{ item.title }}</p>
        <a class="xfer-link" :href="item.url" target="_blank" rel="noopener noreferrer" @click.prevent="openLink">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>
          <span>{{ item.url }}</span>
        </a>
      </template>
      <div v-else class="xfer-file">
        <span class="xfer-file-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
        </span>
        <span class="xfer-file-text">
          <span class="xfer-file-name">{{ item.title || item.filename }}</span>
          <span class="xfer-file-sub">{{ item.filename }}<template v-if="item.size"> · {{ formatBytes(item.size) }}</template></span>
        </span>
      </div>
      <p v-if="expiryText || item.downloadsLeft !== undefined && !outgoing" class="xfer-expiry">
        {{ expiryText }}<template v-if="item.channel === 'drop' && !outgoing && item.downloadsLeft !== undefined && !expired"> · {{ t('transfer.downloadsLeft', { n: item.downloadsLeft }) }}</template>
      </p>
    </div>

    <div v-if="progress !== undefined" class="xfer-progress" role="progressbar" :aria-label="progressText"
      :aria-valuenow="progress === null ? undefined : Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
      <span :class="{ indeterminate: progress === null }" :style="progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }" />
    </div>

    <footer class="xfer-actions">
      <template v-if="item.kind === 'text'">
        <button type="button" class="btn btn-sm" :disabled="busy" @click="copy(item.text ?? '')">{{ t('transfer.copy') }}</button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="saveTxt">{{ t('transfer.saveTxt') }}</button>
      </template>
      <template v-else-if="item.kind === 'link'">
        <button type="button" class="btn btn-sm" :disabled="busy" @click="openLink">{{ t('transfer.openLink') }}</button>
        <button v-if="linkIsBook" type="button" class="btn btn-sm" :disabled="busy" @click="importLink">{{ t('transfer.importLink') }}</button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="copy(item.url ?? '')">{{ t('transfer.copy') }}</button>
      </template>
      <template v-else-if="fileAvailable">
        <button v-if="fileIsBook" type="button" class="btn btn-sm btn-primary" :disabled="busy" @click="importOpen">{{ t('transfer.importOpen') }}</button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="download">{{ t('transfer.download') }}</button>
      </template>
      <span class="spacer" />
      <button
        type="button"
        class="btn btn-sm btn-ghost btn-icon xfer-delete"
        :disabled="busy"
        :title="item.channel === 'drop' && outgoing ? t('transfer.dropRevoke') : t('transfer.delete')"
        :aria-label="item.channel === 'drop' && outgoing ? t('transfer.dropRevoke') : t('transfer.delete')"
        @click="remove"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v12a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7H4a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1zm1 6a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9zm4 0a1 1 0 0 1 2 0v8a1 1 0 1 1-2 0V9z" /></svg>
      </button>
    </footer>
  </article>
</template>

<style scoped>
.xfer-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(560px, 92%);
  padding: 12px 14px 10px;
  border-radius: var(--radius-lg);
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}
.xfer-item.out {
  align-self: flex-end;
  background: var(--brand-light);
  border-color: color-mix(in srgb, var(--brand) 22%, var(--border));
}
.xfer-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
}
.xfer-dir {
  display: inline-grid;
  place-items: center;
  color: var(--text-3);
}
.out .xfer-dir {
  color: var(--brand);
}
.xfer-who {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-weight: 500;
}
.xfer-chan {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
}
.xfer-time {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.xfer-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.xfer-title {
  font-size: 13px;
  color: var(--text-2);
}
.xfer-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.65;
  color: var(--text);
}
.xfer-text.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 8;
  line-clamp: 8;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.xfer-more {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 13px;
}
.xfer-link {
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--brand);
  overflow-wrap: anywhere;
}
.xfer-link svg {
  flex-shrink: 0;
  margin-top: 3px;
}
.xfer-file {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.xfer-file-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: var(--radius);
  background: var(--brand-soft);
  color: var(--brand);
}
.xfer-file-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.xfer-file-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.xfer-file-sub {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.xfer-expiry {
  font-size: 12px;
  color: var(--text-3);
}
.xfer-progress {
  position: relative;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--surface-3);
  overflow: hidden;
}
.xfer-progress span {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--brand);
  border-radius: inherit;
  transition: width var(--dur) var(--ease);
}
.xfer-progress span.indeterminate {
  width: 35%;
  animation: xfer-slide 1.2s var(--ease) infinite;
}
@keyframes xfer-slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(300%); }
}
.xfer-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.xfer-actions .spacer {
  flex: 1;
}
.xfer-delete {
  color: var(--text-3);
}
.xfer-delete:hover {
  color: var(--danger);
}
@media (prefers-reduced-motion: reduce) {
  .xfer-progress span.indeterminate {
    animation: none;
  }
}
</style>
