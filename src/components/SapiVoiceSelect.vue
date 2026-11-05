<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppSelect from './AppSelect.vue'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { playAudio } from '../services/edgeTts'
import { sapiListVoices, sapiSynthesize, type SapiVoice } from '../services/sapiTts'

defineProps<{ busy?: boolean }>()
const settings = useSettings()
const voices = ref<SapiVoice[]>([])
const loaded = ref(false)
const options = computed(() => [
  { value: '', label: t('tts.autoVoice') },
  ...voices.value.map(v => ({ value: v.id, label: v.language ? `${v.name} (${v.language})` : v.name })),
])

onMounted(async () => {
  try {
    voices.value = await sapiListVoices()
  } catch (e) {
    console.error(e)
  } finally {
    loaded.value = true
  }
})

async function audition() {
  try {
    await playAudio(await sapiSynthesize(t('tts.sampleText'), settings.sapiVoice, settings.ttsRate))
  } catch (e) {
    console.error(e)
    toast(t('tts.auditionFailed'), 'error')
  }
}
</script>

<template>
  <div class="sapi-voice">
    <p v-if="loaded && !voices.length" class="sapi-empty">{{ t('tts.sapiEmpty') }}</p>
    <template v-else>
      <AppSelect v-model="settings.sapiVoice" :options="options" :aria-label="t('tts.voice')" />
      <button class="btn btn-sm" :disabled="busy || !loaded" @click="audition">{{ t('tts.audition') }}</button>
    </template>
  </div>
</template>

<style scoped>
.sapi-voice {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.sapi-voice > :first-child {
  flex: 1;
  min-width: 0;
}
.sapi-empty {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--text-2);
}
</style>
