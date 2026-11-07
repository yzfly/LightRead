<script setup lang="ts">
/**
 * 划词翻译面板 (两端阅读页共用; App 里 AppModal 是底部面板)。
 * 路由见 services/translate.ts: 自己的 AI 服务 / 账号每日免费额度 / 未登录时引导登录或填 Key;
 * Android 上另外列出本机能处理文字的翻译应用。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppModal from './AppModal.vue'
import AppSelect from './AppSelect.vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { toast } from '../services/toast'
import { copyText } from '../services/shareOut'
import { providerById } from '../services/ai'
import { listTextApps, openInTextApp, translateRoute, translateText, TranslateError, type TextApp, type TranslateErrorCode } from '../services/translate'
import { ACCOUNT_TRANSLATE_DAILY, resolveTarget, TRANSLATE_MAX_CHARS, TRANSLATE_TARGETS, langName, type TranslateTarget } from '../services/translateCore'

const props = defineProps<{ text: string; book?: string }>()
const emit = defineEmits<{ close: [] }>()
const settings = useSettings()
const router = useRouter()

const source = computed(() => props.text.trim().slice(0, TRANSLATE_MAX_CHARS))
const truncated = computed(() => props.text.trim().length > TRANSLATE_MAX_CHARS)
const sourceOpen = ref(false)
const result = ref('')
const busy = ref(false)
const failure = ref<TranslateErrorCode | null>(null)
const failureDetail = ref('')
const remaining = ref<number | null>(null)
const route = ref(translateRoute())
const apps = ref<TextApp[]>([])
let abort: AbortController | null = null

const targetOptions = computed(() => TRANSLATE_TARGETS.map(v => ({
  value: v,
  label: v === 'auto' ? t('translate.targetAuto') : langName(v),
})))
const target = computed({
  get: () => settings.translateTarget,
  set: (v: TranslateTarget) => { settings.translateTarget = v },
})

/** 面板底部的来源说明 */
const routeNote = computed(() => {
  if (route.value === 'own') return t('translate.viaOwn', { name: providerById(settings.aiProvider).label })
  if (route.value === 'account') {
    return remaining.value === null ? t('translate.viaAccount') : t('translate.viaAccountLeft', { n: remaining.value })
  }
  return ''
})

async function run() {
  abort?.abort()
  const ctrl = new AbortController()
  abort = ctrl
  route.value = translateRoute()
  result.value = ''
  failure.value = null
  failureDetail.value = ''
  if (route.value === 'login') {
    failure.value = 'login'
    return
  }
  busy.value = true
  try {
    const req = {
      text: source.value,
      target: resolveTarget(source.value, settings.translateTarget, settings.language === 'en' ? 'en' : 'zh'),
      ...(props.book ? { book: props.book } : {}),
    }
    for await (const chunk of translateText(req, { signal: ctrl.signal, onRemaining: n => { remaining.value = n } })) {
      if (ctrl.signal.aborted) return
      result.value += chunk
    }
    if (!result.value.trim() && !ctrl.signal.aborted) {
      failure.value = 'failed'
    }
  } catch (e: any) {
    if (ctrl.signal.aborted || e?.name === 'AbortError') return
    failure.value = e instanceof TranslateError ? e.code : 'failed'
    failureDetail.value = String(e?.message ?? e).slice(0, 200)
    if (failure.value === 'quota') remaining.value = 0
    if (failure.value === 'login') route.value = 'login'
  } finally {
    if (abort === ctrl) busy.value = false
  }
}

const failureText = computed(() => {
  switch (failure.value) {
    case 'login': return t('translate.needLogin', { n: ACCOUNT_TRANSLATE_DAILY })
    case 'quota': return t('translate.quotaUsed')
    case 'budget': return t('translate.budgetUsed')
    case 'rate': return t('translate.rateLimited')
    case 'failed': return t('translate.failed')
    default: return ''
  }
})

async function copyResult() {
  if (!result.value) return
  try {
    await copyText(result.value.trim())
    toast(t('translate.copied'), 'success')
  } catch {
    toast(t('translate.copyFailed'), 'error')
  }
}

function openApp(app: TextApp) {
  if (openInTextApp(source.value, app)) emit('close')
  else toast(t('translate.appFailed', { name: app.label }), 'error')
}

function goSettings(section: 'sync' | 'ai') {
  emit('close')
  void router.push({ path: '/settings', query: { section } })
}

watch(() => settings.translateTarget, () => { void run() })
onMounted(() => {
  apps.value = listTextApps()
  void run()
})
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <AppModal :title="t('translate.title')" @close="emit('close')">
    <div class="translate-sheet">
      <div class="ts-target">
        <span class="ts-target-label">{{ t('translate.target') }}</span>
        <AppSelect v-model="target" :options="targetOptions" :title="t('translate.target')" />
      </div>

      <button
        type="button"
        class="ts-source"
        :class="{ open: sourceOpen }"
        :aria-expanded="sourceOpen"
        :title="sourceOpen ? t('translate.collapseSource') : t('translate.expandSource')"
        @click="sourceOpen = !sourceOpen"
      >{{ source }}</button>
      <p v-if="truncated" class="ts-note">{{ t('translate.truncated', { n: TRANSLATE_MAX_CHARS }) }}</p>

      <div class="ts-result" aria-live="polite" :aria-busy="busy">
        <p v-if="result" class="ts-text">{{ result }}<span v-if="busy" class="ts-cursor" aria-hidden="true">▍</span></p>
        <p v-else-if="busy" class="ts-loading">{{ t('translate.working') }}</p>
        <div v-else-if="failure" class="ts-failure">
          <p>{{ failureText }}</p>
          <p v-if="failure === 'failed' && failureDetail" class="ts-detail">{{ failureDetail }}</p>
          <div class="ts-failure-actions">
            <button v-if="failure === 'login'" class="btn btn-sm btn-primary" @click="goSettings('sync')">{{ t('translate.login') }}</button>
            <button v-if="failure === 'login' || failure === 'quota' || failure === 'budget'" class="btn btn-sm" @click="goSettings('ai')">{{ t('translate.useOwnKey') }}</button>
            <button v-if="failure === 'failed' || failure === 'rate'" class="btn btn-sm" @click="run">{{ t('translate.retry') }}</button>
          </div>
        </div>
      </div>

      <div v-if="result && !busy" class="ts-actions">
        <button class="btn btn-sm" @click="copyResult">{{ t('translate.copy') }}</button>
        <button class="btn btn-sm" @click="run">{{ t('translate.retry') }}</button>
      </div>

      <div v-if="apps.length" class="ts-apps">
        <span class="ts-apps-label">{{ t('translate.otherApps') }}</span>
        <div class="ts-apps-list">
          <button v-for="app in apps" :key="`${app.pkg}/${app.cls}`" class="btn btn-sm" @click="openApp(app)">{{ app.label }}</button>
        </div>
      </div>

      <p v-if="routeNote" class="ts-note">{{ routeNote }}</p>
    </div>
  </AppModal>
</template>

<style scoped>
.translate-sheet {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: min(520px, 100%);
  padding: 0 var(--space-5) var(--space-5);
}
@media (pointer: coarse) {
  .translate-sheet .btn {
    min-height: 44px;
  }
}
.ts-target {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.ts-target-label,
.ts-apps-label {
  color: var(--text-2);
  font-size: var(--fs-small);
}
.ts-source {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  width: 100%;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-left: 3px solid var(--border);
  border-radius: 0;
  background: none;
  color: var(--text-3);
  font: inherit;
  font-size: var(--fs-small);
  line-height: 1.6;
  text-align: left;
  white-space: pre-wrap;
  cursor: pointer;
}
.ts-source.open {
  display: block;
  max-height: 30vh;
  overflow: auto;
}
.ts-result {
  min-height: 4.5em;
}
.ts-text {
  margin: 0;
  color: var(--text);
  font-size: var(--fs-body);
  line-height: 1.75;
  white-space: pre-wrap;
  user-select: text;
  -webkit-user-select: text;
}
.ts-cursor {
  color: var(--brand);
  animation: ts-blink 1s steps(2) infinite;
}
@keyframes ts-blink {
  50% { opacity: 0; }
}
.ts-loading {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-small);
}
.ts-failure p {
  margin: 0 0 var(--space-2);
  color: var(--text-2);
  font-size: var(--fs-small);
}
.ts-failure .ts-detail {
  color: var(--text-3);
  word-break: break-all;
}
.ts-failure-actions,
.ts-actions,
.ts-apps-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.ts-apps {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}
.ts-note {
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-caption);
}
@media (prefers-reduced-motion: reduce) {
  .ts-cursor {
    animation: none;
  }
}
</style>
