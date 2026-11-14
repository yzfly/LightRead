<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { AI_PROVIDERS } from '../../services/ai'
import { t } from '../../i18n'
import AppSelect from '../AppSelect.vue'
import { LOCAL_AI_PROVIDER } from '../../services/localChatCore'
import { localLlm, refreshLocalLlm } from '../../services/localLlm'

const props = defineProps<{ modelValue: string }>()
onMounted(() => void refreshLocalLlm())
const emit = defineEmits<{ 'update:modelValue': [id: string]; change: [] }>()
// 「本机模型」只在带引擎的版本里列出 (网页版 / iOS / Linux 桌面没有); 已经选着它时保留, 免得下拉框对不上
const options = computed(() => AI_PROVIDERS.filter(p => p.id !== LOCAL_AI_PROVIDER || localLlm.available || props.modelValue === LOCAL_AI_PROVIDER).map(provider => ({ value: provider.id, label: t(`aiProvider.${provider.id}`), description: t(`aiProvider.${provider.id}Desc`) })))
</script>

<template>
  <AppSelect id="ai-provider" :model-value="modelValue" :options="options" :title="t('aiProvider.title')" :description="t('aiProvider.description')" :hint="t('aiProvider.hint')" :aria-label="t('settings.aiProvider')" class="provider-trigger" @update:model-value="emit('update:modelValue', $event)" @change="emit('change')" />
</template>

<style scoped>
.provider-trigger { width: 100%; min-height: 48px; }
</style>
