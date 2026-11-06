<script setup lang="ts">
/** 读者群模块内的问题反馈: 导出诊断日志, 发到群里。桌面与 App 共用。 */
import { ref } from 'vue'
import { t } from '../../i18n'
import { exportDiagnostics, openFeedback } from '../../services/diagnostics'
import { toast } from '../../services/toast'

const busy = ref(false)

async function exportLogs() {
  if (busy.value) return
  busy.value = true
  try {
    if (await exportDiagnostics()) toast(t('settings.diagnosticsExported'), 'success')
  } catch (e) {
    console.warn('export diagnostics failed', e)
    toast(t('settings.diagnosticsExportFailed'), 'error')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="diagnostics">
    <h3 class="diagnostics-title">{{ t('settings.diagnosticsTitle') }}</h3>
    <p class="diagnostics-desc">{{ t('settings.diagnosticsDesc') }}</p>
    <div class="diagnostics-actions">
      <button class="btn btn-sm" :disabled="busy" @click="exportLogs">{{ t('settings.diagnosticsExport') }}</button>
      <a class="diagnostics-github" href="javascript:void 0" @click="openFeedback">{{ t('settings.diagnosticsGithub') }}</a>
    </div>
  </div>
</template>

<style scoped>
.diagnostics {
  margin-top: var(--space-4);
}
.diagnostics-title {
  margin: 0 0 var(--space-1);
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}
.diagnostics-desc {
  margin: 0 0 var(--space-2);
  font-size: var(--fs-small);
  color: var(--text-2);
}
.diagnostics-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
}
.diagnostics-github {
  font-size: var(--fs-small);
  color: var(--text-2);
}
</style>
