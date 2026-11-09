<script setup lang="ts">
/**
 * Windows 自绘标题栏 (与 macOS 对齐: 无系统标题栏与深色细边框, 圆角窗口)。
 * - overlay (非阅读页, 原型 B「侧栏到顶」): 没有标题条, 只有右上角的三个窗口按钮浮在页面上;
 *   拖动与双击最大化由顶行空白处承担 (services/windowChrome.ts inDragBand)。
 * - 阅读页: 一条标题栏, 整条可拖动, 双击最大化 / 还原 (data-tauri-drag-region), 阅读工具栏在其下。
 * 右侧最小化 / 最大化 / 关闭沿用 Windows 习惯的位置; 全屏与摸鱼模式时不显示 (见 styles/main.css「自绘窗口」)。
 */
import { t } from '../i18n'
import { windowAction, windowChrome } from '../services/windowChrome'

defineProps<{ overlay?: boolean }>()
</script>

<template>
  <header class="titlebar" :class="{ 'is-overlay': overlay }" :data-tauri-drag-region="overlay ? undefined : ''">
    <span v-if="!overlay" class="tb-title" data-tauri-drag-region>{{ t('app.windowTitle') }}</span>
    <div class="tb-controls">
      <button type="button" class="tb-btn" :title="t('window.minimize')" :aria-label="t('window.minimize')" @click="windowAction('minimize')">
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M1 5.5h10v1H1z" /></svg>
      </button>
      <button
        type="button"
        class="tb-btn"
        :title="windowChrome.maximized ? t('window.restore') : t('window.maximize')"
        :aria-label="windowChrome.maximized ? t('window.restore') : t('window.maximize')"
        @click="windowAction('toggleMaximize')"
      >
        <svg v-if="!windowChrome.maximized" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path fill="none" stroke="currentColor" d="M1.5 1.5h9v9h-9z" /></svg>
        <svg v-else viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path fill="none" stroke="currentColor" d="M1.5 3.5h7v7h-7zM3.5 3.5v-2h7v7h-2" /></svg>
      </button>
      <button type="button" class="tb-btn tb-close" :title="t('window.close')" :aria-label="t('window.close')" @click="windowAction('close')">
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path fill="none" stroke="currentColor" d="M1.5 1.5l9 9m0-9-9 9" /></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  height: var(--titlebar-h);
  /* 阅读页: 与正文纸色同色 (ReaderView 写入 --reader-chrome-*); 其他阅读页退回应用底色 */
  background: var(--reader-chrome-bg, var(--bg));
  color: var(--reader-chrome-fg, var(--text));
  user-select: none;
}
/* 非阅读页: 只剩右上角的按钮, 高度与顶行一致, 盖在页面上 (页面标题行右侧已让开 --chrome-inset-right) */
.titlebar.is-overlay {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 30;
  height: var(--chrome-band);
  background: none;
}
/* 按钮做成顶行里的圆角小块: 与页面控件同一中线, 彼此留缝, 和窗口右边也留出距离 (不贴着圆角边) */
.titlebar.is-overlay .tb-controls {
  position: static;
  align-self: stretch;
  align-items: center;
  gap: var(--space-1);
  padding-right: var(--space-3);
}
.titlebar.is-overlay .tb-btn {
  width: var(--control-h);
  height: var(--control-h-sm);
  border-radius: var(--radius-sm);
}
.tb-title {
  color: color-mix(in srgb, currentColor 55%, transparent);
  font-size: var(--fs-caption);
  font-weight: var(--fw-medium);
}
.tb-controls {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
}
.tb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--titlebar-h) * 1.4);
  height: 100%;
  border: none;
  background: none;
  color: color-mix(in srgb, currentColor 75%, transparent);
  cursor: default;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.tb-btn:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: inherit;
}
.tb-close:hover {
  background: var(--danger);
  color: var(--on-brand);
}
.tb-btn:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: -2px;
}
</style>
