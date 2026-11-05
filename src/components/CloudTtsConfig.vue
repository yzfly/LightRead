<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppSelect from './AppSelect.vue'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'
import { toast } from '../services/toast'
import { cloudErrorCode, cloudSynthesize, MINIMAX_MODELS, voicesOf, type CloudProvider } from '../services/cloudTts'
import { playAudio } from '../services/edgeTts'
import { resetEdgeFailure } from '../services/tts'

defineProps<{ busy?: boolean }>()
const settings = useSettings()
const CUSTOM = '__custom__'

type Service = 'minimax-cn' | 'minimax-global' | 'doubao'
const service = computed<Service>({
  get: () => settings.cloudTtsProvider === 'doubao' ? 'doubao' : settings.minimaxRegion === 'global' ? 'minimax-global' : 'minimax-cn',
  set: value => {
    settings.cloudTtsProvider = (value === 'doubao' ? 'doubao' : 'minimax') as CloudProvider
    if (value !== 'doubao') settings.minimaxRegion = value === 'minimax-global' ? 'global' : 'cn'
  },
})
const serviceOptions = computed(() => [
  { value: 'minimax-cn', label: t('tts.cloudMinimaxCn') },
  { value: 'minimax-global', label: t('tts.cloudMinimaxGlobal') },
  { value: 'doubao', label: t('tts.cloudDoubao') },
])

const isDoubao = computed(() => settings.cloudTtsProvider === 'doubao')
const apiKey = computed({
  get: () => isDoubao.value ? settings.doubaoApiKey : settings.minimaxApiKey,
  set: value => { if (isDoubao.value) settings.doubaoApiKey = value; else settings.minimaxApiKey = value },
})
const voice = computed({
  get: () => isDoubao.value ? settings.doubaoVoice : settings.minimaxVoice,
  set: value => { if (isDoubao.value) settings.doubaoVoice = value; else settings.minimaxVoice = value },
})

const inCatalog = () => voicesOf(settings.cloudTtsProvider).some(v => v.id === voice.value)
const customMode = ref(!inCatalog())
const voiceChoice = computed({
  get: () => customMode.value ? CUSTOM : voice.value,
  set: value => {
    customMode.value = value === CUSTOM
    voice.value = value === CUSTOM ? '' : value
  },
})
const voiceOptions = computed(() => [
  ...voicesOf(settings.cloudTtsProvider).map(v => ({
    value: v.id,
    label: v.label,
    group: t(v.gender === 'female' ? 'tts.cloudGroupFemale' : 'tts.cloudGroupMale'),
  })),
  { value: CUSTOM, label: t('tts.cloudVoiceCustom'), group: t('tts.cloudGroupOther') },
])
const modelOptions = MINIMAX_MODELS.map(m => ({ value: m, label: m }))

watch(() => settings.cloudTtsProvider, () => { customMode.value = !inCatalog() })
// 改了配置就重新尝试, 不沿用上一次配置失败后的回退状态
watch([service, apiKey, voice, () => settings.minimaxModel, () => settings.doubaoAppId], () => resetEdgeFailure())

const auditioning = ref(false)
async function audition() {
  auditioning.value = true
  try {
    await playAudio(await cloudSynthesize(settings, t('tts.sampleText'), settings.ttsRate))
  } catch (e) {
    const code = cloudErrorCode(e)
    toast(code ? t(`tts.cloudError.${code}`) : t('tts.auditionFailed'), 'error', 6000)
  } finally {
    auditioning.value = false
  }
}
</script>

<template>
  <div class="cloud-tts">
    <label class="cloud-field">
      <span>{{ t('tts.cloudService') }}</span>
      <AppSelect v-model="service" :options="serviceOptions" :aria-label="t('tts.cloudService')" />
    </label>
    <label class="cloud-field">
      <span>{{ t('tts.cloudKey') }}</span>
      <input v-model="apiKey" class="input" type="password" autocomplete="new-password" :placeholder="t('tts.cloudKeyPh')" />
    </label>
    <label v-if="isDoubao" class="cloud-field">
      <span>{{ t('tts.cloudAppId') }}</span>
      <input v-model="settings.doubaoAppId" class="input" autocomplete="off" :placeholder="t('tts.cloudAppIdPh')" />
    </label>
    <label v-else class="cloud-field">
      <span>{{ t('tts.cloudModel') }}</span>
      <AppSelect v-model="settings.minimaxModel" :options="modelOptions" :aria-label="t('tts.cloudModel')" />
    </label>
    <div class="cloud-field">
      <span>{{ t('tts.voice') }}</span>
      <div class="cloud-voice">
        <AppSelect v-model="voiceChoice" :options="voiceOptions" :aria-label="t('tts.voice')" />
        <button class="btn btn-sm" :disabled="busy || auditioning || !apiKey.trim()" @click="audition">{{ t('tts.audition') }}</button>
      </div>
    </div>
    <label v-if="customMode" class="cloud-field">
      <span>{{ t('tts.cloudVoiceId') }}</span>
      <input v-model="voice" class="input" autocomplete="off" spellcheck="false" :placeholder="t('tts.cloudVoiceIdPh')" />
    </label>
    <p class="cloud-hint">{{ t('tts.cloudHint') }}</p>
  </div>
</template>

<style scoped>
.cloud-tts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
}
.cloud-field {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-small);
  color: var(--text-2);
}
.cloud-voice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.cloud-voice > :first-child {
  flex: 1;
  min-width: 0;
}
.cloud-hint {
  margin: 0;
  font-size: var(--fs-caption);
  line-height: 1.5;
  color: var(--text-3);
}
</style>
