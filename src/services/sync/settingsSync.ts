/**
 * 设置同步: 纯函数, 不碰 vue / pinia / 存储, 可在 node 里测试. 规则见 docs/sync.md「设置同步」.
 *
 * - 每个可同步的设置路径 ('reader.fontSize'、'webdavUrl' …) 是 SyncDoc.settings 里的一个 LWW 寄存器,
 *   stamp.t 是该项**最后一次被用户修改的时间** (settingsTracker 记录), 不是同步时间:
 *   谁改得晚谁赢, 与哪台设备先同步无关.
 * - 白名单 / 设备相关 / 密钥的划分见下面的 SETTINGS_SYNC_SPEC; 新增设置项必须在这里归类
 *   (test-sync-settings.mjs 会检查每个默认设置都已归类).
 * - 密钥项只在发送方开启 syncSecrets 时写进文档; 文档里缺席表示「不变」, 不会删掉远端已有的值.
 *   接收方只落地比本机修改时间更新的值, 所以没发出去的本机新密钥不会被远端的旧值盖掉.
 * - 预设 (大字 / 夜间 / 护眼 / 歌词 / 墨水屏) 临时改动的键按「开启前的值」同步, 见 readSyncedSettings.
 */
import { same, stableKey, cmpStamp } from './merge.ts'
import type {
  LocalSettings, SettingStamp, SettingsApplyEntry, SettingsDoc, SettingsSyncPort, Stamp,
} from './types'

/** sync: 随同步带到其他设备; secret: 仅开启「同步密码与密钥」时同步; local: 只属于本机 */
export type SettingClass = 'sync' | 'secret' | 'local'
export interface SettingsSpec {
  [key: string]: SettingClass | SettingsSpec
}

const SYNC = 'sync' as const
const SECRET = 'secret' as const
const LOCAL = 'local' as const

/**
 * 每个设置项 (与 stores/settings.ts 的 SettingsState 同构) 是否同步. 对象表示按子键分别同步 (各自一个寄存器),
 * 叶子 'sync' 的值整体同步 (数组 / 字典如 githubBookRepos、ambient.layers、dianjing.kinds 整体 LWW).
 */
export const SETTINGS_SYNC_SPEC: SettingsSpec = {
  /** 结构版本: 各设备 load() 时自己迁移 */
  version: LOCAL,
  language: SYNC,
  appearance: SYNC,
  reader: {
    fontSize: SYNC,
    lineHeight: SYNC,
    gap: SYNC,
    theme: SYNC,
    flow: SYNC,
    maxColumnCount: SYNC,
    portraitScroll: SYNC,
    continuousScroll: SYNC,
    /** 字体名: 别的设备没有这个字体时按 CSS 回退, 照样同步 */
    fontFamily: SYNC,
    justify: SYNC,
    letterSpacing: SYNC,
    progressDisplay: SYNC,
  },
  pdf: {
    renderer: SYNC,
    layout: SYNC,
    mode: SYNC,
    fit: SYNC,
    spreadMode: SYNC,
  },
  layoutOverrides: {
    reader: { fontSize: SYNC, lineHeight: SYNC, gap: SYNC, flow: SYNC, maxColumnCount: SYNC, continuousScroll: SYNC },
    pdf: { mode: SYNC, fit: SYNC, spreadMode: SYNC },
  },
  /** 导入的字体文件只在本机 */
  customFonts: LOCAL,
  githubBookRepos: SYNC,
  autoReadSeconds: SYNC,
  volumeKeyTurn: SYNC,
  pdfReflowDefault: SYNC,
  /** 听书引擎取决于本机能力 (本地离线音色要下载模型, 网页没有) */
  ttsEngine: LOCAL,
  ttsRate: SYNC,
  /** 系统语音的音色名因系统而异 */
  ttsVoice: LOCAL,
  edgeVoice: SYNC,
  localVoiceId: SYNC,
  /** SAPI 语音取决于这台 Windows 装了什么 */
  sapiVoice: LOCAL,
  cloudTtsProvider: SYNC,
  minimaxRegion: SYNC,
  minimaxModel: SYNC,
  minimaxVoice: SYNC,
  minimaxApiKey: SECRET,
  doubaoVoice: SYNC,
  doubaoApiKey: SECRET,
  doubaoAppId: SECRET,
  /** 网络环境相关: 代理只对这台设备 / 这个浏览器有意义 */
  corsProxy: LOCAL,
  httpProxy: LOCAL,
  /** 本机路径 */
  calibrePath: LOCAL,
  libraryRoot: LOCAL,
  /** 匿名统计的开关按设备 (关掉的设备不会因同步被重新打开) */
  usageStats: LOCAL,
  /** 同步本身的开关按设备 */
  syncSettings: LOCAL,
  syncSecrets: LOCAL,
  aiProvider: SYNC,
  aiBaseUrl: SYNC,
  aiApiKey: SECRET,
  aiModel: SYNC,
  /** 本机安装的 Agent 引擎与可执行文件路径 */
  paperAgentEngine: LOCAL,
  paperAgentExecutables: LOCAL,
  webdavUrl: SYNC,
  webdavUser: SYNC,
  webdavPass: SECRET,
  webdavProvider: SYNC,
  /** 自动同步 / 是否传书籍文件按设备 (手机可能只要进度不要书) */
  webdavSyncAuto: LOCAL,
  webdavSyncFiles: LOCAL,
  dailyGoalMinutes: SYNC,
  dianjing: {
    /** 点睛阅读选的版本 (基础 / 智能) */
    level: SYNC,
    enabled: SYNC,
    consentAll: SYNC,
    /** 键是本机书 id, 各设备不同 */
    perBook: LOCAL,
    density: SYNC,
    densityFine: LOCAL,
    kinds: SYNC,
    channel: SYNC,
    /** 键是本机书 id */
    fiction: LOCAL,
    chapterCard: SYNC,
  },
  readingMode: {
    typewriter: {
      unit: SYNC,
      cpm: SYNC,
      wpm: SYNC,
      upcoming: SYNC,
      punctuationPause: SYNC,
      freshInk: SYNC,
      sound: SYNC,
      soundPreset: SYNC,
      // 音量随设备 (手机外放与电脑音箱差别大)
      soundVolume: LOCAL,
      pageDwellMs: SYNC,
    },
    lyric: {
      lines: SYNC,
      others: SYNC,
      anchor: SYNC,
      driver: SYNC,
      scale: SYNC,
    },
    wordGuide: {
      enabled: SYNC,
      style: SYNC,
      strength: SYNC,
      intensity: SYNC,
      color: SYNC,
      /** 词与词 / 重点词 */
      mark: SYNC,
    },
    /** 大字 / 墨水屏是预设开关, 与本机的预设快照 (presets) 配套, 按设备 */
    largeText: LOCAL,
    eink: LOCAL,
    immersive: {
      enabled: SYNC,
      hideFooter: SYNC,
    },
    eyeCare: {
      theme: SYNC,
      dim: SYNC,
      reminder: SYNC,
      intervalMin: SYNC,
    },
    night: {
      schedule: SYNC,
      from: SYNC,
      to: SYNC,
    },
    /** 预设快照 (开启时记下的原值), 只对本机有意义 */
    presets: LOCAL,
  },
  ambient: {
    scene: SYNC,
    master: SYNC,
    layers: SYNC,
    noiseColor: SYNC,
    duckWithVoice: SYNC,
    duckLevel: SYNC,
    pauseWhenHidden: SYNC,
  },
  /** 可选功能开关 (书单推荐 / 互传) 是使用偏好, 随同步带到其他设备 */
  features: {
    recommendedBooklists: SYNC,
    transfer: SYNC,
  },
}

function flatten(spec: SettingsSpec, prefix = '', out: Record<string, SettingClass> = {}) {
  for (const [k, v] of Object.entries(spec)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[path] = v
    else flatten(v, path, out)
  }
  return out
}

/** 路径 → 归类 (含 local, 用于文档与测试) */
export const SETTING_CLASSES: Readonly<Record<string, SettingClass>> = flatten(SETTINGS_SYNC_SPEC)
const pathsOf = (c: SettingClass) => Object.keys(SETTING_CLASSES).filter(p => SETTING_CLASSES[p] === c).sort()
/** 普通同步项 */
export const SYNCED_SETTING_PATHS: readonly string[] = pathsOf(SYNC)
/** 密钥项: 仅发送方开启 syncSecrets 时写进文档 */
export const SECRET_SETTING_PATHS: readonly string[] = pathsOf(SECRET)
/** 只属于本机的项 (不读、不写、不落地) */
export const LOCAL_SETTING_PATHS: readonly string[] = pathsOf(LOCAL)
/** 会参与同步的全部路径 (普通 + 密钥) */
export const ALL_SYNC_PATHS: readonly string[] = [...SYNCED_SETTING_PATHS, ...SECRET_SETTING_PATHS].sort()
const SECRET_SET = new Set(SECRET_SETTING_PATHS)

export const isSecretSetting = (path: string) => SECRET_SET.has(path)

/**
 * WebDAV 连接的几项. 本机 webdavUrl 为空 (没连或在本机「断开」了) 时这几项都不发出:
 * 断开只影响这台设备, 不会把别的设备的 WebDAV 一起断掉; 之后别处换了新的 WebDAV 配置照样会过来.
 */
export const WEBDAV_CONNECTION_PATHS: readonly string[] = ['webdavPass', 'webdavProvider', 'webdavUrl', 'webdavUser']
const WEBDAV_SET = new Set(WEBDAV_CONNECTION_PATHS)

// ---- 路径读写 ----

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function getPath(state: unknown, path: string): unknown {
  let cur: unknown = state
  for (const k of path.split('.')) {
    if (!isObj(cur)) return undefined
    cur = cur[k]
  }
  return cur
}

function setPath(state: unknown, path: string, value: unknown): boolean {
  const keys = path.split('.')
  let cur: unknown = state
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur)) return false
    cur = cur[k]
  }
  if (!isObj(cur)) return false
  cur[keys[keys.length - 1]] = value
  return true
}

// ---- 预设 (services/readingModes/presets.ts): 预设临时改的键按开启前的值同步 ----

interface PresetRec { before: Obj; applied: Obj; order: number }

/** 设置路径 → 预设记录里的键 ('reader.x' / 'typewriter.x'); 预设管不到的路径返回 null */
function presetKeyOf(path: string): string | null {
  if (path.startsWith('reader.')) return path
  if (path.startsWith('readingMode.typewriter.')) return `typewriter.${path.slice('readingMode.typewriter.'.length)}`
  return null
}

const sameValue = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : Object.is(a, b)

/**
 * 正被预设管着的键: 返回最底层持有者 (它的 before 即用户本来的值); 没有持有者,
 * 或当前值已不是最上层持有者写入的值 (用户在模式里手动改过) 时返回 null, 按当前值同步.
 */
function presetHolder(state: unknown, path: string): { rec: PresetRec; key: string } | null {
  const key = presetKeyOf(path)
  if (!key) return null
  const presets = getPath(state, 'readingMode.presets')
  if (!isObj(presets)) return null
  const holders = Object.values(presets)
    .filter((r): r is PresetRec => isObj(r) && isObj(r.applied) && isObj(r.before) && key in r.applied
      && typeof r.order === 'number')
    .sort((a, b) => a.order - b.order)
  if (!holders.length) return null
  const top = holders[holders.length - 1]
  if (!sameValue(getPath(state, path), top.applied[key])) return null
  return key in holders[0].before ? { rec: holders[0], key } : null
}

/**
 * 读出可同步的设置 (含密钥项; 是否写进文档由 buildSettingsRegs 决定).
 * 正被预设 (大字 / 夜间 / 歌词 …) 临时改着的键取预设开启前的值: 预设是本机的临时状态,
 * 开关预设不算修改设置, 也不会把临时值同步到别的设备.
 */
export function readSyncedSettings(state: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const path of ALL_SYNC_PATHS) {
    const held = presetHolder(state, path)
    const v = held ? held.rec.before[held.key] : getPath(state, path)
    if (v !== undefined) out[path] = v
  }
  return out
}

/** 写入一项设置 (调用方负责深拷贝); 正被预设管着的键改写预设的快照, 预设关闭时恢复到这个值 */
export function writeSyncedSetting(state: unknown, path: string, value: unknown): boolean {
  const held = presetHolder(state, path)
  if (held) {
    held.rec.before[held.key] = value
    return true
  }
  return setPath(state, path, value)
}

// ---- 修改时间 (本机元数据) ----

/** 本机设置的同步元数据 (持久化在 localStorage, 见 settingsTracker.ts) */
export interface SettingsSyncMeta {
  /** 路径 → 最后修改时间 */
  stamps: Record<string, SettingStamp>
  /** 路径 → 上次记录时的值 (stableKey), 用于发现修改 */
  snap: Record<string, string>
}

/** 修改时间: 现在, 且严格晚于已知的时间 (时钟偏慢的设备改了也能盖过刚收到的值) */
const bump = (prev: SettingStamp | undefined, now: number): SettingStamp => ({ t: Math.max(now, (prev?.t ?? 0) + 1) })

/**
 * 初始化 / 校正元数据 (启动时). 第一次见到某项 (刚升级到带设置同步的版本, 或新加的设置项):
 * 与默认值相同记修改时间 0 (从没改过, 不发出去, 任何设备的值都能盖过它), 否则记 1
 * (改过但不知道何时: 胜过默认值, 输给之后的任何修改). 已记录过但值变了 (追踪之外改的): 记为现在.
 */
export function initSettingsMeta(
  prev: Partial<SettingsSyncMeta> | null | undefined,
  values: Record<string, unknown>,
  defaultValues: Record<string, unknown>,
  now: number,
): SettingsSyncMeta {
  const meta: SettingsSyncMeta = {
    stamps: isObj(prev?.stamps) ? { ...(prev!.stamps as Record<string, SettingStamp>) } : {},
    snap: isObj(prev?.snap) ? { ...(prev!.snap as Record<string, string>) } : {},
  }
  for (const [p, s] of Object.entries(meta.stamps)) {
    if (!isObj(s) || typeof s.t !== 'number' || !Number.isFinite(s.t)) delete meta.stamps[p]
  }
  for (const path of ALL_SYNC_PATHS) {
    if (!(path in values)) continue
    const key = stableKey(values[path])
    if (!(path in meta.snap)) {
      meta.stamps[path] ??= { t: same(values[path], defaultValues[path]) ? 0 : 1 }
      meta.snap[path] = key
    } else if (meta.snap[path] !== key) {
      meta.stamps[path] = bump(meta.stamps[path], now)
      meta.snap[path] = key
    }
  }
  return meta
}

/** 记录用户修改: 值与上次记录不同的项, 修改时间记为现在. 返回有变化的路径 */
export function recordSettingsChanges(meta: SettingsSyncMeta, values: Record<string, unknown>, now: number): string[] {
  const changed: string[] = []
  for (const path of ALL_SYNC_PATHS) {
    if (!(path in values)) continue
    const key = stableKey(values[path])
    if (meta.snap[path] === key) continue
    meta.snap[path] = key
    meta.stamps[path] = bump(meta.stamps[path], now)
    changed.push(path)
  }
  return changed
}

/**
 * 深拷贝设置值。设置状态是 Vue 的响应式对象, 读出的对象 / 数组是 Proxy, 浏览器的 structuredClone
 * 遇到 Proxy 会抛 DataCloneError (「#<Object> could not be cloned」, 安卓 v1.14.0 账号同步报错);
 * 设置值都是可 JSON 化的普通数据, 失败时退回按 JSON 复制, 结果等价。
 */
export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

// ---- 文档 ----

/**
 * 本机设置 → 文档寄存器. 修改时间为 0 (从没改过) 的不写; 密钥项只在 includeSecrets 时写;
 * 本机没连 WebDAV (webdavUrl 为空) 时 WebDAV 连接的几项不写.
 * 本机改的 stamp.d 为本机 deviceId; 从别处收到的沿用来源设备 (与来源文档里的寄存器完全一致).
 */
export function buildSettingsRegs(local: LocalSettings, deviceId: string, includeSecrets: boolean): SettingsDoc {
  const out: SettingsDoc = {}
  const davOff = !String(local.values.webdavUrl ?? '').trim()
  for (const path of ALL_SYNC_PATHS) {
    if (!includeSecrets && SECRET_SET.has(path)) continue
    if (davOff && WEBDAV_SET.has(path)) continue
    const s = local.stamps[path]
    const value = local.values[path]
    if (!s || !(s.t > 0) || value === undefined || value === null) continue
    out[path] = { value: cloneValue(value), stamp: { t: s.t, d: s.d || deviceId } }
  }
  return out
}

/** 远端值与本机值同类型才落地 (防畸形 / 未来格式的数据把设置写坏) */
function sameShape(local: unknown, incoming: unknown): boolean {
  if (local === undefined || incoming === undefined || incoming === null) return false
  if (Array.isArray(local) !== Array.isArray(incoming)) return false
  if (typeof local !== typeof incoming) return false
  if (typeof incoming === 'number') return Number.isFinite(incoming)
  return true
}

/**
 * 合并结果 → 要落地的设置: 只看白名单路径 (普通 + 密钥), 寄存器比本机修改时间新且类型相符才落地.
 * 密钥不论本机是否开启 syncSecrets 都按此规则落地 (远端有才落地; 本机没发出去的较新密钥不会被盖掉).
 * 值相同但 stamp 更新的也返回 (changed=false), 让本机记下来源 stamp, 写文档时与来源一致.
 * WebDAV 连接整组落地: 地址换了时, 账号 / 服务商 / 密码 (远端有的) 跟着地址一起落地, 即使本机的修改时间更晚
 * (如本机断开过 WebDAV), 免得新地址配上本机的旧账号.
 */
export function planSettingsApply(
  merged: SettingsDoc | undefined,
  local: LocalSettings,
  deviceId: string,
): SettingsApplyEntry[] {
  const out: SettingsApplyEntry[] = []
  if (!merged) return out
  for (const path of ALL_SYNC_PATHS) {
    const reg = merged[path]
    if (!reg || reg.value === null || reg.value === undefined) continue
    const s = local.stamps[path]
    const mine: Stamp = { t: s?.t ?? 0, d: s?.d || deviceId }
    if (cmpStamp(reg.stamp, mine) <= 0) continue
    if (!sameShape(local.values[path], reg.value)) continue
    out.push({
      path,
      value: cloneValue(reg.value),
      stamp: { ...reg.stamp },
      changed: !same(local.values[path], reg.value),
    })
  }
  if (out.some(e => e.path === 'webdavUrl' && e.changed)) {
    for (const path of WEBDAV_CONNECTION_PATHS) {
      const reg = merged[path]
      if (out.some(e => e.path === path) || !reg || !sameShape(local.values[path], reg.value)) continue
      if (same(local.values[path], reg.value)) continue
      out.push({ path, value: cloneValue(reg.value), stamp: { ...reg.stamp }, changed: true })
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }
  return out
}

// ---- 端口 ----

export interface SettingsPortOptions {
  /** 当前设置状态 (pinia store 的 $state, 或测试里的纯对象); 落地时直接改它 */
  state: () => unknown
  meta: SettingsSyncMeta
  includeSecrets: boolean
  now?: () => number
  /** 元数据变了 (需要持久化) */
  onMetaChange?: () => void
}

/**
 * engine 用的设置端口. read() 先把还没记下的修改补记 (同步前一刻的改动不会被远端旧值盖掉);
 * apply() 写入设置并同时更新修改时间与快照, 所以同步落地的值不会被当成本机修改再发出去 (不会来回打架).
 */
export function createSettingsSyncPort(opts: SettingsPortOptions): SettingsSyncPort {
  const now = opts.now ?? Date.now
  const { meta } = opts
  return {
    includeSecrets: opts.includeSecrets,
    read() {
      const values = readSyncedSettings(opts.state())
      if (recordSettingsChanges(meta, values, now()).length) opts.onMetaChange?.()
      return { values, stamps: cloneValue(meta.stamps) }
    },
    apply(entries) {
      const state = opts.state()
      for (const e of entries) {
        if (e.changed && !writeSyncedSetting(state, e.path, cloneValue(e.value))) continue
        meta.stamps[e.path] = { t: e.stamp.t, d: e.stamp.d }
        meta.snap[e.path] = stableKey(e.value)
      }
      // 旧客户端没有显式选择标记: 推断为手动, 但不能覆盖更新的「恢复自动」。
      // 先应用整批再比较时间, 使同批的显式标记优先, 并沿用来源时间避免同步回声。
      for (const e of entries) {
        const path = `layoutOverrides.${e.path}`
        if (getPath(state, path) === undefined) continue
        const saved = meta.stamps[path]
        if (cmpStamp(e.stamp, { t: saved?.t ?? 0, d: saved?.d ?? '' }) <= 0) continue
        setPath(state, path, true)
        meta.stamps[path] = { ...e.stamp }
        meta.snap[path] = stableKey(true)
      }
      if (entries.length) opts.onMetaChange?.()
    },
  }
}
