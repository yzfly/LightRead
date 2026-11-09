import type { Directive } from 'vue'

/**
 * 原生 autofocus 只在页面加载时生效, Vue 后插入的弹窗输入框不会自动得到焦点。
 * 用法: <script setup> 里 import { vAutofocus }, 模板写 v-autofocus; v-autofocus="false" 时不抢焦点。
 */
export const vAutofocus: Directive<HTMLElement, boolean | undefined> = {
  mounted(el, binding) {
    if (binding.value === false) return
    requestAnimationFrame(() => {
      if (el.isConnected) el.focus({ preventScroll: true })
    })
  },
}
