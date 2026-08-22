/** 界面外观: 把设置里的 appearance 解析为实际主题并写到 <html data-theme>。 */
import { ref, watchEffect, onScopeDispose } from 'vue'
import { useSettings } from '../stores/settings'
import { isTauri } from '../storage/types'

export type ResolvedTheme = 'light' | 'dark'

/** 当前已解析的界面主题 (system 已展开为 light/dark), 供阅读正文 auto 主题等跟随 */
export const resolvedTheme = ref<ResolvedTheme>(
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
    ? 'dark'
    : 'light',
)

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
  resolvedTheme.value = theme
  const root = document.documentElement
  if (root.dataset.theme === theme) return
  root.dataset.theme = theme
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = THEME_COLOR[theme]
  // 桌面端同步原生窗口主题, 否则 Windows 标题栏仍是系统色, 与应用深色不一致
  if (isTauri()) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
      .catch(() => { /* 旧版 shell 不支持 setTheme 时保持系统标题栏 */ })
  }
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
