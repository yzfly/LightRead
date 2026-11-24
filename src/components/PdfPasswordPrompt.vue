<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'

const props = defineProps<{ wrong: boolean; attempt: number }>()
const emit = defineEmits<{ submit: [password: string, remember: boolean]; back: [] }>()

const password = ref('')
const remember = ref(true)
const input = ref<HTMLInputElement>()

function submit() {
  if (password.value) emit('submit', password.value, remember.value)
}

onMounted(() => input.value?.focus())
// 输错后清空并重新聚焦, 方便直接重输
watch(() => props.attempt, async () => {
  if (!props.wrong) return
  password.value = ''
  await nextTick()
  input.value?.focus()
})
</script>

<template>
  <form class="pdf-password" @submit.prevent="submit">
    <svg class="pdf-password-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
    <h2>{{ t('reader.pdfPasswordTitle') }}</h2>
    <label class="pdf-password-field">
      <span>{{ t('reader.pdfPasswordLabel') }}</span>
      <input
        ref="input"
        v-model="password"
        class="input"
        type="password"
        autocomplete="current-password"
        :aria-invalid="wrong"
        aria-describedby="pdf-password-error"
      />
    </label>
    <p v-if="wrong" id="pdf-password-error" class="pdf-password-error" role="alert">{{ t('reader.pdfPasswordWrong') }}</p>
    <label class="pdf-password-remember">
      <input v-model="remember" type="checkbox" />
      <span>{{ t('reader.pdfPasswordRemember') }}</span>
    </label>
    <div class="pdf-password-actions">
      <button type="button" class="btn" @click="emit('back')">{{ t('common.back') }}</button>
      <button type="submit" class="btn btn-primary" :disabled="!password">{{ t('reader.pdfPasswordOpen') }}</button>
    </div>
  </form>
</template>

<style scoped>
.pdf-password {
  width: min(100%, 320px);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 0 var(--space-4);
  color: var(--text);
}
.pdf-password-icon {
  width: 32px;
  height: 32px;
  align-self: center;
  fill: none;
  stroke: var(--text-3);
  stroke-width: 1.6;
  stroke-linecap: round;
}
.pdf-password h2 {
  margin: 0;
  text-align: center;
  font-size: var(--fs-subtitle);
  font-weight: var(--fw-semibold);
}
.pdf-password-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--fs-small);
  color: var(--text-2);
}
.pdf-password-error {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--danger);
}
.pdf-password-remember {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-small);
  color: var(--text-2);
}
.pdf-password-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
