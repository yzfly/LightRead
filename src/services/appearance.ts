/** 界面外观: 把设置里的 appearance 解析为实际主题并写到 <html data-theme>。 */
import { watchEffect, onScopeDispose } from 'vue'
import { useSettings } from '../stores/settings'

export type ResolvedTheme = 'light' | 'dark'

const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: '#f5f6f8',
  dark: '#121417',
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme(theme: ResolvedTheme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (root.dataset.theme === theme) return
  root.dataset.theme = theme
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = THEME_COLOR[theme]
}

/** 在组件 setup 中调用: 跟随设置与系统偏好实时切换主题。 */
export function useAppearance() {
  const settings = useSettings()
  const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

  const sync = () => {
    const pref = settings.appearance
    applyTheme(pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref)
  }

  watchEffect(sync)
  mql?.addEventListener('change', sync)
  onScopeDispose(() => mql?.removeEventListener('change', sync))
}
