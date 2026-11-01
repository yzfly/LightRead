<script setup lang="ts">
/** 选择文件夹后的确认: 找到几本、跳过了哪些重复格式, 确认后交给导入 / 上传流程 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FolderPlan } from '../services/folderPick'
import type { FolderFile, FolderScan } from '../services/folderSource'
import { FOLDER_MAX_FILES } from '../services/folderSource'
import { detectFormat, FORMAT_LABELS } from '../services/format'
import { t } from '../i18n'

const props = defineProps<{
  action: 'import' | 'upload'
  allowBooklists?: boolean
  scanning?: boolean
  scan?: FolderScan
  plan?: FolderPlan<FolderFile>
  /** 上传的单本上限 (MB), 用于「超过 N MB」 */
  maxMb?: number
}>()
const emit = defineEmits<{ confirm: [createBooklists: boolean]; cancel: [] }>()
const createBooklists = ref(true)
const panel = ref<HTMLElement>()
const confirmBtn = ref<HTMLButtonElement>()
let previousFocus: HTMLElement | null = null

const count = computed(() => props.plan?.selected.length ?? 0)
const droppedCount = computed(() => props.plan?.skippedDuplicates.reduce((n, g) => n + g.dropped.length, 0) ?? 0)
const summary = computed(() => {
  const plan = props.plan
  if (!plan) return ''
  const extras: string[] = []
  if (droppedCount.value) extras.push(t('folder.extraDuplicates', { n: droppedCount.value }))
  if (plan.unsupported) extras.push(t('folder.extraUnsupported', { n: plan.unsupported }))
  if (plan.alreadyInLibrary.length) extras.push(t('folder.extraExisting', { n: plan.alreadyInLibrary.length }))
  if (plan.oversize.length) extras.push(t('folder.extraOversize', { n: plan.oversize.length, mb: props.maxMb ?? 0 }))
  return t('folder.found', { n: plan.selected.length }) + (extras.length ? t('folder.extra', { list: extras.join(t('folder.sep')) }) : '')
})
const formatOf = (entry: FolderFile) => {
  const format = detectFormat(entry.name)
  return format ? FORMAT_LABELS[format] : ''
}
const sizeOf = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('cancel') }
}
onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null
  void nextTick(() => panel.value?.focus())
})
watch(() => props.plan, plan => { if (plan) void nextTick(() => (count.value ? confirmBtn.value : panel.value)?.focus()) })
onBeforeUnmount(() => previousFocus?.focus?.())
</script>

<template>
  <Teleport to="body">
    <div class="modal-mask folder-mask" @click.self="emit('cancel')" @keydown="keydown">
      <section ref="panel" class="modal folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-pick-title" tabindex="-1">
        <h3 id="folder-pick-title">{{ t('folder.title') }}<small v-if="scan?.name" class="folder-name">{{ scan.name }}</small></h3>
        <p v-if="scanning || !plan" class="folder-muted" role="status">{{ t('folder.scanning') }}</p>
        <template v-else>
          <p class="folder-summary" role="status" aria-live="polite">{{ summary }}</p>
          <p v-if="scan?.truncated" class="folder-warn">{{ t('folder.truncated', { n: FOLDER_MAX_FILES }) }}</p>
          <p v-if="scan?.depthLimited" class="folder-warn">{{ t('folder.depthLimited') }}</p>
          <p v-if="!count" class="folder-muted">{{ t('folder.empty') }}</p>
          <p v-if="droppedCount" class="folder-muted">{{ t('folder.rule') }}</p>
          <label v-if="action === 'import' && allowBooklists && count" class="folder-booklists">
            <input v-model="createBooklists" type="checkbox" aria-describedby="folder-booklists-hint">
            <span>{{ t('folder.createBooklists') }}<small id="folder-booklists-hint">{{ t('folder.booklistsHint') }}</small></span>
          </label>
          <details v-if="count" class="folder-list folder-selected">
            <summary><svg class="folder-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>{{ t('folder.listSelected', { n: count }) }}</summary>
            <ul>
              <li v-for="entry in plan.selected" :key="entry.path"><span class="folder-path">{{ entry.path }}</span><span class="tag">{{ formatOf(entry) }}</span></li>
            </ul>
          </details>
          <details v-if="plan.skippedDuplicates.length" class="folder-list folder-duplicates">
            <summary><svg class="folder-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>{{ t('folder.listDuplicates', { n: droppedCount }) }}</summary>
            <ul>
              <li v-for="group in plan.skippedDuplicates" :key="group.kept.path" class="folder-group">
                <span class="folder-path"><strong>{{ group.kept.path }}</strong><small>{{ t('folder.dropped', { list: group.dropped.map(d => d.path).join(t('folder.sep')) }) }}</small></span>
              </li>
            </ul>
          </details>
          <details v-if="plan.alreadyInLibrary.length" class="folder-list folder-existing">
            <summary><svg class="folder-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>{{ t('folder.listExisting', { n: plan.alreadyInLibrary.length }) }}</summary>
            <ul><li v-for="entry in plan.alreadyInLibrary" :key="entry.path"><span class="folder-path">{{ entry.path }}</span></li></ul>
          </details>
          <details v-if="plan.oversize.length" class="folder-list folder-oversize">
            <summary><svg class="folder-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.3 5.3a1 1 0 0 1 1.4 0l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 1 1-1.4-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 0-1.4z"/></svg>{{ t('folder.listOversize', { n: plan.oversize.length }) }}</summary>
            <ul><li v-for="entry in plan.oversize" :key="entry.path"><span class="folder-path">{{ entry.path }}</span><small>{{ sizeOf(entry.size) }}</small></li></ul>
          </details>
        </template>
        <div class="folder-actions">
          <button class="btn btn-sm" @click="emit('cancel')">{{ t('common.cancel') }}</button>
          <button ref="confirmBtn" class="btn btn-sm btn-primary folder-confirm" :disabled="scanning || !count" @click="emit('confirm', action === 'import' && !!allowBooklists && createBooklists)">
            {{ t(action === 'upload' ? 'folder.upload' : 'folder.import', { n: count }) }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 上传弹窗 z-index 1100, 确认框要叠在它上面 */
.folder-mask { z-index: 1200; }
.folder-dialog { width: min(560px, 100%); outline: none; display: flex; flex-direction: column; }
.folder-name { display: block; margin-top: 4px; font-size: 13px; font-weight: 400; color: var(--text-2); overflow-wrap: anywhere; }
.folder-summary { font-size: 15px; line-height: 1.6; color: var(--text); margin: 0 0 8px; }
.folder-muted { font-size: 13px; line-height: 1.6; color: var(--text-2); margin: 0 0 8px; }
.folder-warn { font-size: 13px; line-height: 1.6; color: var(--danger); margin: 0 0 8px; }
.folder-list { border: 1px solid var(--border); border-radius: var(--radius); margin-top: 10px; }
.folder-list summary { cursor: pointer; padding: 10px 12px; font-size: 14px; font-weight: 500; color: var(--text); min-height: 44px; display: flex; align-items: center; gap: 6px; list-style: none; }
.folder-list summary::-webkit-details-marker { display: none; }
.folder-chevron { flex-shrink: 0; color: var(--text-3); transition: transform var(--dur, 0.15s) var(--ease, ease); }
.folder-list[open] .folder-chevron { transform: rotate(90deg); }
.folder-list ul { list-style: none; margin: 0; padding: 0 12px 6px; max-height: 220px; overflow: auto; }
.folder-list li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--border); font-size: 13px; }
.folder-path { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--text); }
.folder-path strong { display: block; font-weight: 500; }
.folder-path small, .folder-list li > small { display: block; margin-top: 2px; color: var(--text-3); font-size: 12px; }
.folder-list li > small { margin: 0; flex-shrink: 0; }
.folder-booklists { display: flex; align-items: flex-start; gap: var(--space-2); color: var(--text); cursor: pointer; }
.folder-booklists small { display: block; color: var(--text-2); }
.folder-booklists input { accent-color: var(--brand); }
.folder-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
@media (max-width: 600px) {
  .folder-actions .btn { flex: 1; min-height: 44px; }
  .folder-list ul { max-height: 180px; }
}
</style>
