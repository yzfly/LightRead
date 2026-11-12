<script setup lang="ts">
/**
 * 听书面板里「本机」语音引擎的那一行 (阅读页与论文阅读页共用):
 * 模型可用时选参考音色; 否则给出下载 / 设备不合适 / 太慢 / 闪退后的说明 (LocalModelPack)。
 */
import { computed, onMounted } from 'vue'
import AppSelect from './AppSelect.vue'
import LocalModelPack from './LocalModelPack.vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { localModel, refreshLocalLlm } from '../services/localLlm'
import { LOCAL_VOICE_MODEL, QWEN_VOICES, voiceModelUsable } from '../services/localVoiceCore'

defineEmits<{ ready: [] }>()
const settings = useSettings()
const usable = computed(() => voiceModelUsable(localModel(LOCAL_VOICE_MODEL)))
onMounted(() => void refreshLocalLlm())
</script>

<template>
  <template v-if="usable">
    <label>{{ t('tts.voice') }}</label>
    <AppSelect v-model="settings.qwenVoice" class="input" :aria-label="t('tts.voice')">
      <option v-for="v in QWEN_VOICES" :key="v" :value="v">{{ t(`localVoice.${v}`) }}</option>
    </AppSelect>
  </template>
  <LocalModelPack v-else kind="tts" compact @ready="$emit('ready')" />
</template>
