<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppModal from './AppModal.vue'
import { confirmation, settleConfirmation } from '../../services/confirm'
import { t } from '../../i18n'
const route = useRoute()
watch(() => route.fullPath, () => settleConfirmation(false))
onBeforeUnmount(() => settleConfirmation(false))
</script>
<template>
  <AppModal v-if="confirmation" :title="confirmation.title || t('v2.confirmAction')" initial-focus=".confirm-cancel" @close="settleConfirmation(false)">
    <p class="confirm-message">{{ confirmation.message }}</p>
    <template #footer>
      <div class="confirm-actions">
        <button type="button" class="btn confirm-cancel" @click="settleConfirmation(false)">{{ t('common.cancel') }}</button>
        <button type="button" class="btn confirm-accept" :class="confirmation.danger ? 'btn-danger' : 'btn-primary'" @click="settleConfirmation(true)">{{ confirmation.confirmLabel || t('common.confirm') }}</button>
      </div>
    </template>
  </AppModal>
</template>
<style scoped>
.confirm-message { margin: 0; padding: 24px 20px; font-size: 16px; white-space: pre-wrap; overflow-wrap: anywhere; text-wrap: pretty; line-height: 1.7; }
.confirm-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.confirm-actions .btn { min-height: 48px; min-width: 0; white-space: nowrap; }
</style>
