import { normalizeFocusLines, normalizeLyricAnchor } from '../services/readingModes/lyric.ts'
import { defineStore } from 'pinia'
import { watch } from 'vue'
import { startSettingsTracking } from '../services/sync/settingsTracker.ts'
import { readSyncedSettings } from '../services/sync/settingsSync.ts'
import { emptyLayoutOverrides, restoreLayoutOverrides, resolveReaderPrefs, resolvePdfPrefs, screenLayout, type LayoutOverrides, type ReaderLayoutKey, type PdfLayoutKey } from '../services/adaptiveLayout.ts'
import { readingViewport } from '../services/readingViewport.ts'
import { isTauri } from '../storage/types.ts'
import type { ZhConvertMode } from '../services/zhConvert.ts'
import type { TranslateTarget } from '../services/translateCore.ts'
import { BASIC_MARK_DEFAULT, migrateLevel, normalizeLevel, savedBasicMark, type BasicMark, type DjLevel } from '../services/dianjing/level.ts'

export interface ReaderPrefs {
  fontSize: number
  lineHeight: number
  /** 页边距百分比 */
  gap: number
  /** 阅读主题; auto 跟随界面外观在浅色/夜间间切换 */
  theme: 'auto' | 'light' | 'sepia' | 'green' | 'dark'
  flow: 'paginated' | 'scrolled'
  /** auto 根据版面判断; 1 / 2 固定栏数 */
  maxColumnCount: 'auto' | 1 | 2
  /** 自动采用横/竖屏默认排版 (历史字段名); 手动设置逐项优先, PDF 同样适用 */
  portraitScroll: boolean
  /** 滚动模式下跨章连续滚动: 章与章首尾相接 (docs/continuous-scroll.md); 关掉回到单章滚动 */
  continuousScroll: boolean
  fontFamily: string
  justify: boolean
  /** 字距 (em), 0 为书籍原样; 大字预设为 0.05 */
  letterSpacing: number
  /** 页脚 / 底栏的阅读进度显示: 页码 + 百分比 / 只看页码 / 只看百分比 */
  progressDisplay: 'both' | 'page' | 'percent'
}

export interface PdfPrefs {
  /** 可见页面位图渲染引擎；文字几何与交互仍由 PDFium 提供 */
  renderer: 'mupdf' | 'pdfium'
  /** original: 保留版式；reflow 仅用于兼容旧设置，产品入口已移除 */
  layout: 'original' | 'reflow'
  /** paged: 整页翻页；scroll: 连续滚动（默认） */
  mode: 'paged' | 'scroll'
  /** 快捷适配: fitH 适高整页 / fitW 适宽（默认） */
  fit: 'fitH' | 'fitW'
  /** Sumatra 风格页布局：单页 / 对页 / 书籍封面错位双页 */
  spreadMode: 'single' | 'facing' | 'book'
}

/** 打字机模式 (docs/reading-modes.md §3.1) */
export interface TypewriterPrefs {
  /** 粒度: 逐字 / 逐句 / 逐行 */
  unit: 'char' | 'sentence' | 'line'
  /** 中文书速度, 字/分 (60–1200) */
  cpm: number
  /** 西文书速度, 词/分 (40–800) */
  wpm: number
  /** 后文: 隐藏 / 淡显 */
  upcoming: 'hidden' | 'ghost'
  punctuationPause: boolean
  /** 墨迹未干: 最新出现的字用强调色 */
  freshInk: boolean
  /** 打字声 (CC0 录音单发样本, 见 services/readingModes/soundPresets.ts) */
  sound: boolean
  /** 打字声音色 (同 soundPresets.TypingSoundPresetId) */
  soundPreset: 'typewriter' | 'mechanical' | 'soft' | 'pen'
  /** 打字声音量 0–1 */
  soundVolume: number
  /** 打完一页后停留多久再自动翻页, 毫秒 */
  pageDwellMs: number
}

/** 歌词模式 (docs/research/reading-modes-landscape.md §4.7); 速度复用 typewriter.cpm / wpm */
export interface LyricPrefs {
  /** 聚焦行数: 1–99 行 (滑动窗口) */
  lines: number
  /** 其余行: 淡显 (正文色 30%) / 隐藏 */
  others: 'dim' | 'hide'
  /** 内部坐标: 顶部 0、底部 1; UI 高度为 1 - anchor */
  anchor: number
  /** 推进: 按速度自动 / 跟听书 / 手动 */
  driver: 'pace' | 'tts' | 'manual'
  /** 歌词字号: 正文字号的倍数 (1.0–1.6) */
  scale: number
}

/** 预设开关的快照 (大字 / 墨水屏 / 歌词 / 夜间 / 护眼): 开启时记下原值, 关闭时恢复; 见 services/readingModes/presets.ts */
export interface PresetRecordPrefs {
  before: Record<string, unknown>
  applied: Record<string, unknown>
  order: number
}

/** 阅读模式 (docs/research/reading-modes-landscape.md §5) */
export interface ReadingModePrefs {
  typewriter: TypewriterPrefs
  lyric: LyricPrefs
  /** 点睛阅读基础版 (按词分色; 默认关): 西文词首强调 / 中文分词交替着色。enabled 只在 dianjing.level 为 basic 时生效 */
  wordGuide: {
    enabled: boolean
    style: 'auto' | 'alternate' | 'fixation'
    strength: 'light' | 'normal'
    /** 着色强度 0.4–1 (默认五档 柔和 … 最强, 可拖动微调); 取代 strength */
    intensity: number
    /** 着色颜色 (精选配色之一) */
    color: 'teal' | 'indigo' | 'amber' | 'rose' | 'forest'
    /**
     * 基础版标什么: boundary = 词与词 (相邻的词交替着色); keywords = 重点词 (离线挑出每段最要紧的词, 密度随 dianjing.density)。
     * 新安装默认重点词; 已有存档没有这个字段时保持词与词 (load 里补, 不升版本)。
     */
    mark: BasicMark
  }
  /** 大字: 预设开关; custom 为在大字模式里手动调过的值 (下次开启沿用) */
  largeText: { enabled: boolean; size: 'large' | 'xlarge'; custom: Record<string, unknown> }
  /** 墨水屏: 纯黑白高对比、字重 +100、无动画; suggestDismissed 为「识别到墨水屏设备」提示已处理 */
  eink: { enabled: boolean; suggestDismissed: boolean }
  /** 沉浸: 隐藏页眉页脚文字 / 工具栏只在轻点时出现; hideFooter 连页码也隐藏 */
  immersive: { enabled: boolean; hideFooter: boolean }
  /** 护眼: 暖色主题 + 应用内调暗 (0–60%) + 休息提醒 (分钟) */
  eyeCare: { theme: 'sepia' | 'green'; dim: number; reminder: boolean; intervalMin: 20 | 30 | 45 }
  /** 夜间定时: from–to 之间自动切到夜间 (HH:MM, 可跨午夜) */
  night: { schedule: boolean; from: string; to: string }
  /** 预设快照 (按预设 id), 持久化以便崩溃后恢复 */
  presets: Record<string, PresetRecordPrefs>
}

/** 可选功能开关 (设置 → 功能); 默认关, 开启后与原先完全一致 */
export interface FeaturePrefs {
  /** 书单推荐: 书源页的「书单推荐」区块与远程书单拉取 (自制书单 / 待找 / 分享导入不受影响) */
  recommendedBooklists: boolean
  /** 互传: 侧栏入口、后台收取、「发送到其他设备」等所有入口 */
  transfer: boolean
}

/** 结构版本: 修正历史默认值时递增 */
const SETTINGS_VERSION = 17

/** v3 时代曾并入用户设置的内置书库 (v4 起社区清单独立远程拉取, 此表仅供迁移清理) */
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

/** 背景音 (services/ambient, docs/research/reading-ambient-audio.md §5.5); 只记住选择, 从不自动播放 */
export interface AmbientPrefs {
  /** 最近一次使用的场景 id */
  scene: string
  /** 主音量 0..1 (滑块值, 按感知曲线映射到增益), 默认 0.3 */
  master: number
  /** 每层音量 0..1, 键为「场景/层」; 缺省用场景默认值 */
  layers: Record<string, number>
  /** 专注噪音的颜色 */
  noiseColor: 'pink' | 'white' | 'brown'
  /** 听书时自动降低 */
  duckWithVoice: boolean
  /** 降低到的倍数 (0.25 = -12 dB) */
  duckLevel: number
  /** 手机切到后台时暂停 (只有背景音在播时) */
  pauseWhenHidden: boolean
}

/**
 * 点睛阅读 (docs/dianjing-reading.md §4.1, services/dianjing/level.ts): 两个版本——
 * 基础版 (按词分色, 不联网; 开关即 readingMode.wordGuide.enabled) 与智能版 (AI, 下面这些字段; 首次开启需同意)。
 */
export interface DianjingPrefs {
  /** 选的版本 (默认基础版); 「点睛阅读开着」= 这个版本开着 */
  level: DjLevel
  /** 智能版: 「所有书开启」后的全局开关 (perBook 未设置的书跟随它) */
  enabled: boolean
  /** 已同意「所有书开启」 */
  consentAll: boolean
  /** 按书开关 (bookId → 开/关); 选「仅本书」即写这里 */
  perBook: Record<string, boolean>
  /**
   * 标记多少 (少 / 适中 / 多), 基础版重点词与智能版共用: 智能版要句 5% / 8% / 15% (按字数);
   * 重点词 基础版 2% / 4% / 8% (占词数), 智能版 只亮重要度≥2 的 AI 词 / 全部 AI 词 / AI 词 + 离线补到 8%
   */
  density: 'low' | 'normal' | 'high'
  /** Fine adjustment on supporting clients; preset mismatch falls back to the synced preset. */
  densityFine?: { value: number; preset: 'low' | 'normal' | 'high' }
  /** 标记类型 (kw: 智能版的重点词) */
  kinds: { key: boolean; term: boolean; note: boolean; kw: boolean }
  /** 通道: auto (已配置自己的密钥则用自己的, 否则内置) / builtin / own */
  channel: 'auto' | 'builtin' | 'own'
  /** 体裁手动设置 (bookId → 叙事 / 非叙事), 未设置时自动识别 */
  fiction: Record<string, 'fiction' | 'nonfiction'>
  /** 章首要义卡 */
  chapterCard: boolean
}

/** 摸鱼模式 (桌面阅读器): 让窗口尽量不显眼 */
export interface StealthPrefs {
  /** 打开图书时自动进入 */
  autoEnter: boolean
  /** 阅读区背景不透明度 0.2–1 (1 为不透明) */
  bgOpacity: number
  /** 正文文字不透明度 0.4–1 (调低像灰字) */
  textOpacity: number
  /** 窗口标题伪装 (任务栏显示的名字) */
  disguise: boolean
  /** 伪装标题; 空时用默认「文档1」 */
  disguiseTitle: string
  /** 老板键 (全局快捷键), 空为不启用 */
  bossKey: string
  /** 窗口置顶 */
  alwaysOnTop: boolean
  /** 不在任务栏和 Alt+Tab 里显示 (找回: 老板键或再次启动轻阅) */
  skipTaskbar: boolean
  /** 截图 / 录屏 / 共享屏幕时隐藏窗口 */
  hideFromCapture: boolean
  /** 上次摸鱼时的窗口位置大小 (物理像素); 摸鱼与普通阅读各记一套 */
  bounds: { x: number; y: number; w: number; h: number } | null
  /** 首次进入时的说明卡已看过 */
  introSeen: boolean
}

interface SettingsState {
  version?: number
  /** 界面语言 */
  language: 'zh' | 'en'
  /** 界面外观: 跟随系统 / 浅色 / 深色 (阅读正文主题另由 reader.theme 控制) */
  appearance: 'system' | 'light' | 'dark'
  reader: ReaderPrefs
  pdf: PdfPrefs
  /** 显式选择过的排版项; 旋转/缩放不会修改它们, 与对应偏好一起同步 */
  layoutOverrides: LayoutOverrides
  /** 导入的自定义字体 (桌面端) */
  customFonts: CustomFontRec[]
  /** 用户自行添加的 GitHub 书库仓库 (owner/repo); 社区清单另行远程拉取 */
  githubBookRepos: string[]
  /** 自动阅读速度: 秒/页 (EPUB 与 PDF 共用) */
  autoReadSeconds: number
  /** PDF 打开方式: auto 文字版用电子书 (重排) 打开、扫描版与论文用原版; original 总是原版. 见 services/pdfReflow/viewMode.ts */
  pdfReflowDefault: 'auto' | 'original'
  /** 听书引擎: edge 在线神经音色 / local 本地离线神经音色 / system 系统语音 / cloud 自带 Key 的 API 语音 / sapi Windows SAPI 5 语音 */
  /** qwen: 本机语音模型 (Qwen3-TTS, 桌面; 需下载, 带不动的机器不提供) */
  ttsEngine: 'edge' | 'local' | 'system' | 'cloud' | 'sapi' | 'qwen'
  /** 听书语速 (0.5 - 2) */
  ttsRate: number
  /** 系统语音音色名称, 空为自动匹配 (中文优先) */
  ttsVoice: string
  /** Edge 在线音色 id */
  edgeVoice: string
  /** 本地音色编号 (Kokoro 0-102) */
  localVoiceId: number
  /** 本机语音模型的参考音色 (services/localVoiceCore.ts 的 QWEN_VOICES) */
  qwenVoice: 'female' | 'male'
  /** SAPI 5 语音的令牌 id, 空为系统默认 */
  sapiVoice: string
  /** API 语音服务商 */
  cloudTtsProvider: 'minimax' | 'doubao'
  /** MiniMax 国内站 / 国际站: 两边的 Key 不通用 */
  minimaxRegion: 'cn' | 'global'
  minimaxModel: string
  minimaxVoice: string
  minimaxApiKey: string
  doubaoVoice: string
  doubaoApiKey: string
  /** 豆包旧版控制台的 App ID; 新版控制台的 API Key 不需要 */
  doubaoAppId: string
  /** Web 端跨域代理模板, {url} 为占位符; 桌面端走原生请求无需代理 */
  corsProxy: string
  /** 桌面端网络代理 (http:// 或 socks5://), 书源请求经此代理 */
  httpProxy: string
  /** Calibre 书库文件夹路径 (桌面端) */
  calibrePath: string
  /** 书库存储根目录 (桌面端), 空为默认应用数据目录 */
  libraryRoot: string
  /** 安卓: 阅读时音量键翻页 (上一页 / 下一页); 听书播放或打开面板时音量键照常调音量 */
  volumeKeyTurn: boolean
  /** AI 助手: 预设 id / 接口地址 / 密钥 / 模型 */
  /** 匿名使用统计 (设置 → 隐私); 默认开启, 可关闭, 见 services/usageStats.ts */
  usageStats: boolean
  /** 设置随同步 (WebDAV / 轻阅账号) 带到其他设备; 设备相关项 (存储路径、代理、本机字体等) 不同步 */
  syncSettings: boolean
  /** 同时同步密码与密钥 (WebDAV 应用密码、AI API Key): 会存到同步端, 默认关闭, 需用户显式开启 */
  syncSecrets: boolean
  aiProvider: string
  aiBaseUrl: string
  aiApiKey: string
  aiModel: string
  /** 划词翻译的目标语言; auto 为中文译英文、其他语言译成界面语言 (services/translateCore.ts) */
  translateTarget: TranslateTarget
  /** 已下载本机翻译模型时优先用它 (不联网、不计次数); 关掉则只用在线翻译 */
  localTranslate: boolean
  /** 正文简繁转换: 关闭 / 繁→简 / 简→繁 (本地 OpenCC, 见 services/zhConvert.ts) */
  zhConvert: ZhConvertMode
  /** 摸鱼模式 (桌面): 无边框 + 半透明 + 老板键, 见 services/stealth.ts */
  stealth: StealthPrefs
  /** AI 辅读: 设置页选择的本机引擎与可选手动可执行文件路径 */
  paperAgentEngine: 'codex' | 'claude' | 'pi'
  paperAgentExecutables: Record<'codex' | 'claude' | 'pi', string>
  /** WebDAV 云备份 */
  webdavUrl: string
  webdavUser: string
  webdavPass: string
  /** 设置页选择的 WebDAV 服务商 (jianguoyun/koofr/selfhosted/other); 空为按 webdavUrl 识别 */
  webdavProvider: string
  /** WebDAV 增量同步: 启动 / 切后台 / 退出阅读器及每 5 分钟自动同步 */
  webdavSyncAuto: boolean
  /** 同步时上传 / 下载书籍文件 (关闭则只同步进度、笔记、书单) */
  webdavSyncFiles: boolean
  /** 阅读记录: 每日阅读目标 (分钟), 0 表示不设目标 */
  dailyGoalMinutes: number
  /** 点睛阅读 */
  dianjing: DianjingPrefs
  /** 阅读模式 (打字机等) */
  readingMode: ReadingModePrefs
  /** 背景音 */
  ambient: AmbientPrefs
  /** 可选功能开关 */
  features: FeaturePrefs
}

const STORAGE_KEY = 'lightread-settings'

const defaults: SettingsState = {
  version: SETTINGS_VERSION,
  language: 'zh',
  appearance: 'system',
  customFonts: [],
  layoutOverrides: emptyLayoutOverrides(),
  githubBookRepos: [],
  reader: {
    fontSize: 18,
    lineHeight: 1.8,
    gap: 6,
    theme: 'auto',
    flow: 'paginated',
    maxColumnCount: 'auto',
    portraitScroll: true,
    continuousScroll: true,
    fontFamily: '',
    justify: true,
    letterSpacing: 0,
    progressDisplay: 'both',
  },
  pdf: {
    renderer: 'mupdf',
    layout: 'original',
    mode: 'scroll',
    fit: 'fitW',
    spreadMode: 'single',
  },
  autoReadSeconds: 15,
  pdfReflowDefault: 'auto',
  ttsEngine: 'edge',
  ttsRate: 1,
  ttsVoice: '',
  edgeVoice: 'zh-TW-HsiaoChenNeural',
  localVoiceId: 50,
  qwenVoice: 'female',
  sapiVoice: '',
  cloudTtsProvider: 'minimax',
  minimaxRegion: 'cn',
  minimaxModel: 'speech-2.8-turbo',
  minimaxVoice: 'female-chengshu',
  minimaxApiKey: '',
  doubaoVoice: 'zh_female_wenroushunv_uranus_bigtts',
  doubaoApiKey: '',
  doubaoAppId: '',
  corsProxy: '',
  httpProxy: '',
  calibrePath: '',
  libraryRoot: '',
  volumeKeyTurn: false,
  usageStats: true,
  syncSettings: true,
  syncSecrets: false,
  aiProvider: 'trial',
  aiBaseUrl: 'https://lightread-ai.jiangshu.ai/v1',
  aiApiKey: '',
  aiModel: 'deepseek-ai/DeepSeek-V4-Flash',
  translateTarget: 'auto',
  localTranslate: true,
  zhConvert: 'off',
  stealth: {
    autoEnter: false,
    bgOpacity: 0.85,
    textOpacity: 1,
    disguise: false,
    disguiseTitle: '',
    bossKey: 'Alt+Shift+Z',
    alwaysOnTop: false,
    skipTaskbar: false,
    hideFromCapture: false,
    bounds: null,
    introSeen: false,
  },
  paperAgentEngine: 'pi',
  paperAgentExecutables: { codex: '', claude: '', pi: '' },
  webdavUrl: '',
  webdavUser: '',
  webdavPass: '',
  webdavProvider: '',
  webdavSyncAuto: false,
  webdavSyncFiles: true,
  dailyGoalMinutes: 30,
  dianjing: {
    level: 'basic',
    enabled: false,
    consentAll: false,
    perBook: {},
    density: 'normal',
    densityFine: undefined,
    kinds: { key: true, term: true, note: true, kw: true },
    channel: 'auto',
    fiction: {},
    chapterCard: true,
  },
  readingMode: {
    typewriter: {
      unit: 'char',
      cpm: 300,
      wpm: 200,
      upcoming: 'hidden',
      punctuationPause: true,
      freshInk: true,
      sound: false,
      soundPreset: 'mechanical',
      soundVolume: 0.4,
      pageDwellMs: 800,
    },
    lyric: { lines: 1, others: 'dim', anchor: 0.382, driver: 'pace', scale: 1.2 },
    wordGuide: { enabled: false, style: 'auto', strength: 'normal', intensity: 0.7, color: 'rose', mark: BASIC_MARK_DEFAULT },
    largeText: { enabled: false, size: 'large', custom: {} },
    eink: { enabled: false, suggestDismissed: false },
    immersive: { enabled: false, hideFooter: false },
    eyeCare: { theme: 'sepia', dim: 0, reminder: true, intervalMin: 20 },
    night: { schedule: false, from: '22:00', to: '07:00' },
    presets: {},
  },
  ambient: {
    scene: 'rain-study',
    master: 0.3,
    layers: {},
    noiseColor: 'pink',
    duckWithVoice: true,
    duckLevel: 0.25,
    pauseWhenHidden: true,
  },
  features: {
    recommendedBooklists: false,
    transfer: false,
  },
}

/** 默认设置的副本 (设置同步判断「从没改过」、测试检查每项设置都已归类) */
export function settingsDefaults(): SettingsState {
  return structuredClone(defaults)
}

/** 阅读模式是嵌套对象: 逐层合并, 以后新增字段时旧存档自动补默认值 */
function mergeReadingMode(saved: unknown): ReadingModePrefs {
  const d = structuredClone(defaults.readingMode)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return d
  const s = saved as Partial<Record<keyof ReadingModePrefs, unknown>>
  const part = <T extends object>(base: T, v: unknown): T =>
    v && typeof v === 'object' && !Array.isArray(v) ? { ...base, ...(v as Partial<T>) } : base
  return {
    typewriter: part(d.typewriter, s.typewriter),
    lyric: part(d.lyric, s.lyric),
    wordGuide: part(d.wordGuide, s.wordGuide),
    largeText: part(d.largeText, s.largeText),
    eink: part(d.eink, s.eink),
    immersive: part(d.immersive, s.immersive),
    eyeCare: part(d.eyeCare, s.eyeCare),
    night: part(d.night, s.night),
    presets: part(d.presets, s.presets),
  }
}

/**
 * 安装版首次启动按系统语言选界面语言 (中文系统中文, 其余英文); 已有设置的用户不变。
 * macOS/iOS 的 WKWebView 在应用未声明本地化时 navigator.language 常报英文, 不可靠, 仍默认中文;
 * 网页版保持中文默认。
 */
export function systemLanguage(language = globalThis.navigator?.language ?? '', userAgent = globalThis.navigator?.userAgent ?? ''): 'zh' | 'en' | undefined {
  if (!language || /Mac OS X|Macintosh|iPhone|iPad/.test(userAgent)) return undefined
  return /^zh\b/i.test(language) ? 'zh' : 'en'
}

function firstRunDefaults(): SettingsState {
  const fresh = structuredClone(defaults)
  if (isTauri()) fresh.language = systemLanguage() ?? fresh.language
  return fresh
}

function load(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return firstRunDefaults()
    const saved = JSON.parse(raw)
    const savedAgentExecutables = saved.paperAgentExecutables != null
      && typeof saved.paperAgentExecutables === 'object'
      && !Array.isArray(saved.paperAgentExecutables)
      ? saved.paperAgentExecutables
      : {}
    const merged = {
      ...structuredClone(defaults),
      ...saved,
      reader: { ...defaults.reader, ...saved.reader },
      pdf: { ...defaults.pdf, ...saved.pdf },
      paperAgentExecutables: { ...defaults.paperAgentExecutables, ...savedAgentExecutables },
      readingMode: mergeReadingMode(saved.readingMode),
      stealth: {
        ...defaults.stealth,
        ...(saved.stealth && typeof saved.stealth === 'object' && !Array.isArray(saved.stealth) ? saved.stealth : {}),
      },
      features: {
        ...defaults.features,
        ...(saved.features && typeof saved.features === 'object' && !Array.isArray(saved.features) ? saved.features : {}),
      },
      dianjing: {
        ...structuredClone(defaults.dianjing),
        ...(saved.dianjing && typeof saved.dianjing === 'object' ? saved.dianjing : {}),
        kinds: { ...defaults.dianjing.kinds, ...(saved.dianjing?.kinds ?? {}) },
      },
    }
    if (!['codex', 'claude', 'pi'].includes(merged.paperAgentEngine)) merged.paperAgentEngine = 'pi'
    if (!['system', 'light', 'dark'].includes(merged.appearance)) merged.appearance = 'system'
    for (const engine of ['codex', 'claude', 'pi'] as const) {
      if (typeof merged.paperAgentExecutables[engine] !== 'string') merged.paperAgentExecutables[engine] = ''
    }
    // v2: PDF 阅读默认翻页+适高 (纠正早期版本持久化下来的滚动模式)
    if ((saved.version ?? 1) < 2) {
      merged.pdf.mode = 'paged'
      merged.pdf.fit = 'fitH'
    }
    // v3: 曾把内置书库并入用户设置; v4: 社区清单改为远程拉取,
    // 用户设置只保留自行添加的仓库, 清掉当年并入的内置项
    if ((saved.version ?? 1) < 4) {
      merged.githubBookRepos = (saved.githubBookRepos ?? []).filter(
        (r: string) => !BUILTIN_BOOK_REPOS.includes(r),
      )
    }
    // v6: 双页布尔值扩展为 Sumatra 风格的单页 / 对页 / 书籍视图。
    if ((saved.version ?? 1) < 6) {
      merged.pdf.spreadMode = saved.pdf?.spread ? 'facing' : 'single'
    }
    // v7: PDF 产品模型回归原版阅读，连续滚动成为默认主模式。
    // 早期版本曾通过迁移强制所有用户使用翻页，因此在此统一纠正一次。
    if ((saved.version ?? 1) < 7) {
      merged.pdf.layout = 'original'
      merged.pdf.mode = 'scroll'
      merged.pdf.fit = 'fitW'
    }
    // v9: 阅读主题默认改为跟随界面外观; 旧默认 light 视为未显式选择, 一并迁入 auto。
    if ((saved.version ?? 1) < 9 && (saved.reader?.theme ?? 'light') === 'light') {
      merged.reader.theme = 'auto'
    }
    // v10: 界面外观默认改为跟随系统; 旧默认 light 视为未显式选择, 一并迁入 system。
    if ((saved.version ?? 1) < 10 && (saved.appearance ?? 'light') === 'light') {
      merged.appearance = 'system'
    }
    // v11: 在线听书默认音色改为台湾腔女声 (曉臻); 仍是旧默认 (晓晓) 的视为未显式选择, 一并迁入。
    if ((saved.version ?? 1) < 11 && (saved.edgeVoice ?? 'zh-CN-XiaoxiaoNeural') === 'zh-CN-XiaoxiaoNeural') {
      merged.edgeVoice = 'zh-TW-HsiaoChenNeural'
    }
    // v12: AI 默认改为内置试用通道 (免配置, 模型 DeepSeek-V4-Flash); 还停在旧默认且没填密钥的 (实际用不了) 一并迁入。
    // 内置通道迁到 jiangshu 账号 (lightread-ai.jiangshu.ai), 旧地址不认新模型名, 已在用内置通道的一并改地址与模型。
    const onOldDefault = (saved.aiProvider ?? 'siliconflow') === 'siliconflow' && !(saved.aiApiKey ?? '').trim()
    if ((saved.version ?? 1) < 12 && (onOldDefault || saved.aiProvider === 'trial')) {
      merged.aiProvider = 'trial'
      merged.aiBaseUrl = defaults.aiBaseUrl
      merged.aiModel = defaults.aiModel
    }
    // v13: 分明阅读 (原仿生阅读) 默认色改为玫瑰; v1.13.1 写入的旧默认 teal 视为未显式选择, 一并迁入。
    if ((saved.version ?? 1) < 13 && (saved.readingMode?.wordGuide?.color ?? 'teal') === 'teal') {
      merged.readingMode.wordGuide.color = 'rose'
    }
    // v14: 按词着色并入点睛阅读成为基础版, 原点睛阅读为智能版; 按旧存档里在用的功能选版本 (services/dianjing/level.ts)
    if ((saved.version ?? 1) < 14 && saved.dianjing?.level == null) {
      const m = migrateLevel(saved)
      merged.dianjing.level = m.level
      merged.readingMode.wordGuide.enabled = m.wordGuideEnabled
    }
    merged.dianjing.level = normalizeLevel(merged.dianjing.level)
    // 基础版「标什么」: 新增字段, 已有存档保持原来的词与词 (新安装默认重点词); 不需要升版本
    merged.readingMode.wordGuide.mark = savedBasicMark(saved.readingMode?.wordGuide?.mark)
    // v15: 旧值 2 表示自动双栏, 迁为 auto; 显式单栏保持不变。
    if ((saved.version ?? 1) < 15 && merged.reader.maxColumnCount === 2) {
      merged.reader.maxColumnCount = 'auto'
    }
    // v16: the upper preset now uses height 0.618; preserve the centered preset.
    if ((saved.version ?? 1) < 16 && merged.readingMode.lyric.anchor === 0.4) merged.readingMode.lyric.anchor = 0.382
    merged.readingMode.lyric.lines = normalizeFocusLines(merged.readingMode.lyric.lines)
    merged.readingMode.lyric.anchor = normalizeLyricAnchor(merged.readingMode.lyric.anchor)
    let stamps = {}
    try { stamps = JSON.parse(localStorage.getItem('lightread-settings-sync') || 'null')?.stamps ?? {} } catch { /* 无历史记录 */ }
    merged.layoutOverrides = restoreLayoutOverrides(saved.layoutOverrides, readSyncedSettings(merged), readSyncedSettings(defaults), stamps)
    merged.version = SETTINGS_VERSION
    return merged
  } catch {
    return structuredClone(defaults)
  }
}

export const useSettings = defineStore('settings', {
  state: (): SettingsState => load(),
  getters: {
    screenPreset: () => screenLayout(readingViewport.value),
    readerPrefs(): ReaderPrefs {
      return resolveReaderPrefs(this.reader, this.layoutOverrides.reader, this.screenPreset, this.readingMode.presets)
    },
    pdfPrefs(): PdfPrefs {
      return resolvePdfPrefs(this.pdf, this.layoutOverrides.pdf, this.screenPreset, this.reader.portraitScroll)
    },
  },
  actions: {
    setReaderPreference<K extends keyof ReaderPrefs>(key: K, value: ReaderPrefs[K]) {
      this.reader[key] = value
      if (key in this.layoutOverrides.reader) this.layoutOverrides.reader[key as ReaderLayoutKey] = true
    },
    setPdfPreference<K extends keyof PdfPrefs>(key: K, value: PdfPrefs[K]) {
      this.pdf[key] = value
      if (key in this.layoutOverrides.pdf) this.layoutOverrides.pdf[key as PdfLayoutKey] = true
    },
    persistOnChange() {
      // 设置同步: 记录每项可同步设置的修改时间 (services/sync/settingsSync.ts)
      startSettingsTracking(() => this.$state, defaults)
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
      this.layoutOverrides.reader = emptyLayoutOverrides().reader
    },
  },
})
