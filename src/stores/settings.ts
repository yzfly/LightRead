import { defineStore } from 'pinia'
import { watch } from 'vue'

export interface ReaderPrefs {
  fontSize: number
  lineHeight: number
  /** 页边距百分比 */
  gap: number
  /** 阅读主题 */
  theme: 'light' | 'sepia' | 'green' | 'dark'
  flow: 'paginated' | 'scrolled'
  maxColumnCount: 1 | 2
  fontFamily: string
  justify: boolean
}

export interface PdfPrefs {
  /** paged: 整页翻页 (阅读); scroll: 连续滚动 (细读大图) */
  mode: 'paged' | 'scroll'
  /** 翻页模式缩放: fitH 适高整页 (默认) / fitW 适宽 */
  fit: 'fitH' | 'fitW'
  /** 翻页模式下双页并列 */
  spread: boolean
}

/** 结构版本: 修正历史默认值时递增 */
const SETTINGS_VERSION = 3

/** 内置 GitHub 书库 (真实书籍文件仓库, 经文件数验证) */
const BUILTIN_BOOK_REPOS = [
  '0voice/expert_readed_books',
  'Mikoto10032/DeepLearning',
  'guanpengchn/awesome-books',
  'singgel/JAVA',
  'jyfc/ebook',
]

export interface CustomFontRec {
  name: string
  file: string
}

interface SettingsState {
  version?: number
  /** 界面语言 */
  language: 'zh' | 'en'
  reader: ReaderPrefs
  pdf: PdfPrefs
  /** 导入的自定义字体 (桌面端) */
  customFonts: CustomFontRec[]
  /** GitHub 书库仓库列表 (owner/repo) */
  githubBookRepos: string[]
  /** 自动阅读速度: 秒/页 (EPUB 与 PDF 共用) */
  autoReadSeconds: number
  /** 听书引擎: edge 在线神经音色 / local 本地离线神经音色 / system 系统语音 */
  ttsEngine: 'edge' | 'local' | 'system'
  /** 听书语速 (0.5 - 2) */
  ttsRate: number
  /** 系统语音音色名称, 空为自动匹配 (中文优先) */
  ttsVoice: string
  /** Edge 在线音色 id */
  edgeVoice: string
  /** 本地音色编号 (Kokoro 0-102) */
  localVoiceId: number
  /** Web 端跨域代理模板, {url} 为占位符; 桌面端走原生请求无需代理 */
  corsProxy: string
  /** 桌面端网络代理 (http:// 或 socks5://), 书源请求经此代理 */
  httpProxy: string
  /** Calibre 书库文件夹路径 (桌面端) */
  calibrePath: string
  /** 书库存储根目录 (桌面端), 空为默认应用数据目录 */
  libraryRoot: string
  /** WebDAV 云备份 */
  webdavUrl: string
  webdavUser: string
  webdavPass: string
}

const STORAGE_KEY = 'lightread-settings'

const defaults: SettingsState = {
  version: SETTINGS_VERSION,
  language: 'zh',
  customFonts: [],
  githubBookRepos: [...BUILTIN_BOOK_REPOS],
  reader: {
    fontSize: 18,
    lineHeight: 1.8,
    gap: 6,
    theme: 'light',
    flow: 'paginated',
    maxColumnCount: 2,
    fontFamily: '',
    justify: true,
  },
  pdf: {
    mode: 'paged',
    fit: 'fitH',
    spread: false,
  },
  autoReadSeconds: 15,
  ttsEngine: 'edge',
  ttsRate: 1,
  ttsVoice: '',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  localVoiceId: 50,
  corsProxy: '',
  httpProxy: '',
  calibrePath: '',
  libraryRoot: '',
  webdavUrl: '',
  webdavUser: '',
  webdavPass: '',
}

function load(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(defaults)
    const saved = JSON.parse(raw)
    const merged = {
      ...structuredClone(defaults),
      ...saved,
      reader: { ...defaults.reader, ...saved.reader },
      pdf: { ...defaults.pdf, ...saved.pdf },
    }
    // v2: PDF 阅读默认翻页+适高 (纠正早期版本持久化下来的滚动模式)
    if ((saved.version ?? 1) < 2) {
      merged.pdf.mode = 'paged'
      merged.pdf.fit = 'fitH'
    }
    // v3: 合并新增的内置 GitHub 书库 (保留用户自行添加/删除后的自定义项)
    if ((saved.version ?? 1) < 3) {
      merged.githubBookRepos = [...new Set([...(saved.githubBookRepos ?? []), ...BUILTIN_BOOK_REPOS])]
    }
    merged.version = SETTINGS_VERSION
    return merged
  } catch {
    return structuredClone(defaults)
  }
}

export const useSettings = defineStore('settings', {
  state: (): SettingsState => load(),
  actions: {
    persistOnChange() {
      let timer: ReturnType<typeof setTimeout> | undefined
      watch(
        () => this.$state,
        state => {
          clearTimeout(timer)
          timer = setTimeout(
            () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)),
            300,
          )
        },
        { deep: true },
      )
    },
    resetReader() {
      this.reader = structuredClone(defaults.reader)
    },
  },
})
