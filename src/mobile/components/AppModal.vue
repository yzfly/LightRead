<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../../i18n'
import { useRouter } from 'vue-router'
import { isTauri } from '../../storage/types'

const props = defineProps<{ title: string; description?: string; initialFocus?: string; closeDisabled?: boolean }>()
const router = useRouter()
const emit = defineEmits<{ close: [] }>()
function dismiss() { if (!props.closeDisabled) emit('close') }
const panel = ref<HTMLElement>()
const mask = ref<HTMLElement>()
const titleId = `app-modal-${Math.random().toString(36).slice(2)}`
let previousFocus: HTMLElement | null = null
const inertElements: Array<[HTMLElement, boolean]> = []
const scrollElements: Array<[HTMLElement, string]> = []
let removeNavigationGuard: (() => void) | undefined
let closeWatcher: { destroy(): void } | undefined
let removeAndroidBack: (() => void) | undefined
let disposed = false
// 软键盘: Android WebView 不缩布局视口, 贴底的面板 (例如 AppSelect 的搜索) 会整块落在键盘后面。
// 按 visualViewport 让出键盘高度, 并把面板高度限制在键盘上方的可见区域内。
const keyboard = ref<{ inset: number; height: number } | null>(null)
function updateKeyboard() {
  const view = window.visualViewport
  const inset = view ? Math.max(0, window.innerHeight - view.height - view.offsetTop) : 0
  keyboard.value = inset > 80 && view ? { inset, height: view.height } : null
}
const maskStyle = computed(() => keyboard.value ? { paddingBottom: `${keyboard.value.inset}px` } : undefined)
const panelStyle = computed(() => keyboard.value ? { maxHeight: `${Math.round(keyboard.value.height * 0.9)}px`, paddingBottom: '0px' } : undefined)
const focusable = () => [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length)
function keydown(event: KeyboardEvent) {
  if (mask.value?.inert) return
  // Do not let reader shortcuts run behind an open choice / confirmation panel.
  event.stopPropagation()
  if (event.key === 'Escape') { event.preventDefault(); dismiss(); return }
  if (event.key !== 'Tab') return
  const items = focusable(), first = items[0], last = items.at(-1)
  if (!first) { event.preventDefault(); panel.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || !panel.value?.contains(document.activeElement))) {
    event.preventDefault(); last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
function globalKeydown(event: KeyboardEvent) {
  // Applying a choice may disable/remove the focused button and move focus to body.
  // Escape must still close this sheet before reader shortcuts or CloseWatcher run.
  if (event.key === 'Escape' || (event.key === 'Tab' && !panel.value?.contains(document.activeElement))) keydown(event)
}
onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement | null
  updateKeyboard()
  window.visualViewport?.addEventListener('resize', updateKeyboard)
  window.visualViewport?.addEventListener('scroll', updateKeyboard)
  document.addEventListener('keydown', globalKeydown, true)
  for (const el of document.querySelectorAll<HTMLElement>('#app, [data-app-modal], [role=dialog], [role=alertdialog]')) {
    if (el === mask.value || mask.value?.contains(el)) continue
    inertElements.push([el, el.inert]); el.inert = true
  }
  for (const el of [document.body, ...document.querySelectorAll<HTMLElement>('.main')]) {
    scrollElements.push([el, el.style.overflow]); el.style.overflow = 'hidden'
  }
  // Tauri Back navigates history directly. Cancel that navigation and dismiss the top panel;
  // vue-router restores the previous history position without adding phantom entries.
  removeNavigationGuard = router.beforeEach(() => {
    if (mask.value?.inert) return
    dismiss()
    return false
  })
  // Android can have no WebView history (for example after restoring the app).
  // Handle Back while the modal exists so it closes instead of exiting the app.
  if (isTauri() && /Android/i.test(navigator.userAgent)) {
    void import('@tauri-apps/api/app').then(async ({ onBackButtonPress }) => {
      if (disposed) return
      const listener = await onBackButtonPress(() => {
        if (!disposed && !mask.value?.inert) dismiss()
      })
      if (disposed) await listener.unregister()
      else removeAndroidBack = () => { void listener.unregister() }
    }).catch(error => console.warn('Modal Back listener unavailable', error))
  }
  // Browser close requests (Escape / supported mobile browsers) require no system UI.
  const Watcher = (window as unknown as { CloseWatcher?: new () => EventTarget & { destroy(): void } }).CloseWatcher
  if (Watcher) {
    const watcher = new Watcher()
    watcher.addEventListener('close', dismiss)
    closeWatcher = watcher
  }
  await nextTick()
  const target = (props.initialFocus ? props.initialFocus.split(',').map(selector => panel.value?.querySelector<HTMLElement>(selector.trim())).find(Boolean) : null) ?? focusable()[0] ?? panel.value
  target?.focus({ preventScroll: true })
  target?.scrollIntoView({ block: 'nearest' })
})
onBeforeUnmount(() => {
  disposed = true
  window.visualViewport?.removeEventListener('resize', updateKeyboard)
  window.visualViewport?.removeEventListener('scroll', updateKeyboard)
  document.removeEventListener('keydown', globalKeydown, true)
  removeAndroidBack?.()
  removeNavigationGuard?.()
  closeWatcher?.destroy()
  for (const [el, value] of inertElements) el.inert = value
  for (const [el, value] of scrollElements) el.style.overflow = value
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <div ref="mask" class="modal-mask app-modal-mask" data-app-modal :style="maskStyle" @keydown="keydown" @click.self="dismiss">
      <section ref="panel" class="app-modal" :style="panelStyle" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="description ? `${titleId}-desc` : undefined" tabindex="-1">
        <div class="app-modal-handle" aria-hidden="true" />
        <header class="app-modal-header">
          <div><h2 :id="titleId">{{ title }}</h2><p v-if="description" :id="`${titleId}-desc`">{{ description }}</p></div>
          <button type="button" class="app-modal-close" :aria-label="t('common.close')" :disabled="closeDisabled" @click="dismiss">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div class="app-modal-body"><slot /></div>
        <footer v-if="$slots.footer" class="app-modal-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.app-modal-mask { z-index: 1300; }
.app-modal { display: flex; flex-direction: column; width: min(480px, 100%); max-height: 86vh; max-height: 86dvh; color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); overflow: hidden; }
.app-modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 16px 16px 20px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.app-modal-header h2 { margin: 0; font-size: 18px; line-height: 1.5; font-weight: 600; }
.app-modal-header p { margin: 5px 0 0; font-size: 13px; line-height: 1.5; color: var(--text-3); }
.app-modal-close { display: grid; place-items: center; width: 44px; height: 44px; flex-shrink: 0; border: none; border-radius: var(--radius); background: var(--surface-2); color: var(--text-2); cursor: pointer; }
.app-modal-close:focus-visible { outline: 2px solid var(--brand); outline-offset: -3px; }
.app-modal-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.app-modal-footer { padding: 12px 20px; flex-shrink: 0; border-top: 1px solid var(--border); font-size: 12px; line-height: 1.5; color: var(--text-3); }
@media (max-width: 600px) {
  .app-modal-mask { padding-top: var(--lr-safe-top); }
  .app-modal { width: 100%; max-height: calc(90vh - var(--lr-safe-top)); max-height: calc(90dvh - var(--lr-safe-top)); border-radius: var(--radius-xl) var(--radius-xl) 0 0; border-bottom: 0; padding-left: var(--lr-safe-left); padding-right: var(--lr-safe-right); padding-bottom: var(--lr-safe-bottom); }
}
/* Hallmark · shared App sheet spacing · P5 H5 E4 S5 R5 V4 */
.app-modal-handle { flex: none; width: 34px; height: 4px; margin: 10px auto 0; border-radius: var(--radius-pill); background: var(--border); }
.app-modal-header { align-items: center; padding: var(--space-2) var(--space-4) var(--space-3); }
.app-modal-header > div { min-width: 0; flex: 1; }
.app-modal-header h2 { font-size: 18px; overflow-wrap: anywhere; }
.app-modal-close { background: transparent; }
.app-modal-footer { padding: var(--space-4) var(--space-5); }
.app-modal-footer :deep(.btn) { min-height: 48px; }
.app-modal-body { scrollbar-gutter: stable; }
@media (max-width: 720px) { .app-modal-mask { align-items: flex-end; padding: 0; padding-top: var(--lr-safe-top); }.app-modal { width: 100%; max-height: calc(90dvh - var(--lr-safe-top)); border-radius: var(--radius-xl) var(--radius-xl) 0 0; padding-bottom: var(--lr-safe-bottom); } }
@media (min-width: 721px) { .app-modal-handle { display: none; }.app-modal-header { padding-top: var(--space-4); } }
</style>
