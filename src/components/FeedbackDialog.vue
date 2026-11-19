<script setup lang="ts">
/** 应用内反馈: 类型 + 文字 + 联系方式 + 是否附诊断日志。桌面与 App 共用, 见 services/feedback.ts */
import { reactive, ref } from 'vue'
import AppModal from './AppModal.vue'
import { t } from '../i18n'
import { FeedbackError, defaultFeedbackContact, sendFeedback } from '../services/feedback'
import { FEEDBACK_KINDS, FEEDBACK_MAX_TEXT, feedbackProblem, type FeedbackDraft } from '../services/feedbackCore'
import { toast } from '../services/toast'

const emit = defineEmits<{ close: [] }>()

const DRAFT_KEY = 'lightread-feedback-draft'
function loadDraftText(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}
function saveDraftText(text: string) {
  try {
    if (text.trim()) localStorage.setItem(DRAFT_KEY, text)
    else localStorage.removeItem(DRAFT_KEY)
  } catch { /* 存不了: 只是少了草稿 */ }
}

const draft = reactive<FeedbackDraft>({
  kind: 'bug',
  text: loadDraftText(),
  contact: defaultFeedbackContact(),
  includeLogs: true,
})
const busy = ref(false)
const error = ref('')

async function submit() {
  if (busy.value) return
  const problem = feedbackProblem(draft)
  if (problem) {
    error.value = t(problem)
    return
  }
  busy.value = true
  error.value = ''
  try {
    await sendFeedback(draft)
    saveDraftText('')
    toast(t('feedback.sent'), 'success')
    emit('close')
  } catch (e) {
    error.value = e instanceof FeedbackError ? e.message : t('feedback.errServer')
  } finally {
    busy.value = false
  }
}

function close() {
  // 没发出去的文字留着, 下次打开还在
  saveDraftText(draft.text)
  emit('close')
}
</script>

<template>
  <AppModal :title="t('feedback.title')" :description="t('feedback.desc')" initial-focus="#feedback-text" @close="close">
    <form class="feedback" @submit.prevent="submit">
      <div class="segmented feedback-kind" role="group" :aria-label="t('feedback.kind')">
        <button
          v-for="k in FEEDBACK_KINDS"
          :key="k"
          type="button"
          :class="{ active: draft.kind === k }"
          :aria-pressed="draft.kind === k"
          @click="draft.kind = k"
        >{{ t(`feedback.kind.${k}`) }}</button>
      </div>

      <label class="feedback-field">
        <span class="sr-only">{{ t('feedback.text') }}</span>
        <textarea
          id="feedback-text"
          v-model="draft.text"
          class="input feedback-text"
          rows="6"
          :maxlength="FEEDBACK_MAX_TEXT"
          :placeholder="t(`feedback.placeholder.${draft.kind}`)"
        />
      </label>

      <label class="feedback-field">
        <span class="feedback-label">{{ t('feedback.contact') }}</span>
        <input v-model="draft.contact" class="input" type="text" autocomplete="email" :placeholder="t('feedback.contactPlaceholder')" />
      </label>

      <label class="feedback-logs">
        <input v-model="draft.includeLogs" type="checkbox" />
        <span>
          {{ t('feedback.includeLogs') }}
          <small>{{ t('feedback.includeLogsHint') }}</small>
        </span>
      </label>

      <p v-if="error" class="feedback-error" role="alert">{{ error }}</p>

      <div class="feedback-actions">
        <button type="button" class="btn" :disabled="busy" @click="close">{{ t('common.cancel') }}</button>
        <button type="submit" class="btn btn-primary" :disabled="busy || !draft.text.trim()">
          {{ busy ? t('feedback.sending') : t('feedback.send') }}
        </button>
      </div>
    </form>
  </AppModal>
</template>

<style scoped>
.feedback {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5) calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
}
@media (max-width: 720px) {
  .feedback {
    padding-inline: var(--space-4);
  }
}
.feedback-kind {
  align-self: flex-start;
}
.feedback-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.feedback-label {
  font-size: var(--fs-small);
  color: var(--text-2);
}
.feedback-text {
  width: 100%;
  min-height: 8em;
  resize: vertical;
  font: inherit;
  line-height: 1.6;
}
.feedback-logs {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--fs-body);
  cursor: pointer;
}
.feedback-logs input {
  margin-top: 0.3em;
  flex-shrink: 0;
}
.feedback-logs small {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-small);
  color: var(--text-3);
}
.feedback-error {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--danger);
}
.feedback-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
