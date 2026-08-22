import type { ReaderPrefs } from '../stores/settings'

export interface ReaderThemeColors {
  bg: string
  fg: string
  link: string
}

export type ReaderThemeName = Exclude<ReaderPrefs['theme'], 'auto'>

export const READER_THEMES: Record<ReaderThemeName, ReaderThemeColors> = {
  light: { bg: '#ffffff', fg: '#1d2129', link: '#1664ff' },
  sepia: { bg: '#faf3e7', fg: '#453c2c', link: '#8f6c2e' },
  green: { bg: '#c7edcc', fg: '#243528', link: '#1e6b4a' },
  dark: { bg: '#17181a', fg: '#c5c8ce', link: '#6a9bff' },
}

/** auto 跟随界面外观: 浅色外观读白底, 深色外观读夜间 */
export function resolveReaderTheme(theme: ReaderPrefs['theme'], appDark: boolean): ReaderThemeName {
  return theme === 'auto' ? (appDark ? 'dark' : 'light') : theme
}

export function resolveReaderColors(theme: ReaderPrefs['theme'], appDark: boolean): ReaderThemeColors {
  return READER_THEMES[resolveReaderTheme(theme, appDark)]
}

/** 主题选择按钮 (含 auto), 顺序固定; auto 的色板用斜切双色示意跟随外观 */
export const READER_THEME_CHOICES: Array<{ name: ReaderPrefs['theme']; bg: string; fg: string }> = [
  ...(Object.entries(READER_THEMES) as Array<[ReaderThemeName, ReaderThemeColors]>)
    .map(([name, c]) => ({ name: name as ReaderPrefs['theme'], bg: c.bg, fg: c.fg })),
  { name: 'auto', bg: 'linear-gradient(135deg, #ffffff 50%, #17181a 50%)', fg: '#8a919c' },
]

export const FONT_FAMILIES = [
  { labelKey: 'reader.fontDefault', value: '' },
  { labelKey: 'reader.fontSongti', value: '"Songti SC", "Noto Serif SC", SimSun, serif' },
  { labelKey: 'reader.fontHeiti', value: '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif' },
  { labelKey: 'reader.fontKaiti', value: '"Kaiti SC", KaiTi, "Noto Serif SC", serif' },
]

/** 注入到 foliate 渲染 iframe 的样式 */
export function getReaderCSS(prefs: ReaderPrefs, appDark: boolean): string {
  const theme = resolveReaderTheme(prefs.theme, appDark)
  const colors = READER_THEMES[theme]
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${theme === 'dark' ? 'dark' : 'light'};
      color: ${colors.fg};
      font-size: ${prefs.fontSize}px;
      ${prefs.fontFamily ? `font-family: ${prefs.fontFamily};` : ''}
    }
    body { background: none !important; }
    p, li, blockquote, dd {
      line-height: ${prefs.lineHeight};
      ${prefs.justify ? 'text-align: justify;' : ''}
      -webkit-hyphens: auto;
      hyphens: auto;
    }
    a:any-link { color: ${colors.link}; }
    /* 脚注弹出场景保持可读 */
    aside[epub|type~="footnote"] { background: ${colors.bg}; }
  `
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#ffd54d',
  green: '#7ed99b',
  blue: '#7cb8ff',
  red: '#ff8f8f',
}
