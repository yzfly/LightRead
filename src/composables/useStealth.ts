/**
 * 摸鱼模式的页面状态, 两个桌面阅读页共用 (ReaderView: EPUB / TXT 等; PaperReaderView: PDF / 论文)。
 *
 * 负责: 进入 / 退出时调原生窗口命令 (services/stealth.ts → src-tauri/src/stealth.rs)、
 * 给 <html> 加 lr-stealth (页面各层不画底色)、伪装标题 / 置顶 / 老板键变更即时生效、
 * Esc 退出 (捕获阶段, 先于阅读页自己的快捷键)、老板键藏起窗口时通知阅读页静音、
 * 离开阅读页时恢复窗口。阅读页只负责「隐藏哪些控件」和「静音哪些声音」, 经 hooks 传入。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import { useSettings } from '../stores/settings'
import { toast } from '../services/toast'
import { logEvent } from '../services/diagnostics'
import { bossKeyLabel, enterStealthWindow, exitStealthWindow, onBossKey, stealthSupported } from '../services/stealth'

export interface StealthHooks {
  /** 进入前: 退出全屏 / 幻灯片, 关掉面板, 收起工具栏 */
  beforeEnter?: () => void | Promise<void>
  /** 页面状态切换后 (进入与退出都调用): 刷新页眉页脚等 */
  changed?: (on: boolean) => void
  /**
   * 原生窗口改完之后 (进入与退出都调用): 去边框 / 换位置会改变窗口尺寸, 透明窗口的 WebView2 有时不重画,
   * PDF 页借此重新排版渲染 (2026-11-08 Win10: 自动进入时 PDF 正文空白)
   */
  windowChanged?: () => void
  /** 退出后: 恢复工具栏 */
  afterExit?: () => void
  /** 老板键藏起窗口: 暂停听书 / 自动翻页 / 背景音, 免得窗口藏了声音还在 */
  bossHidden?: () => void
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200)

export function useStealth(hooks: StealthHooks = {}) {
  const settings = useSettings()
  const available = stealthSupported()
  const active = ref(false)
  /** 首次进入的说明卡 */
  const intro = ref(false)
  /** 老板键本次是否注册成功 (说明卡与细条据此显示) */
  const bossKeyOk = ref(false)
  let seq = 0
  let stopBossListen: (() => void) | null = null

  /** 把窗口设成摸鱼状态 (标题伪装 / 置顶 / 老板键变更时也重新调用); 失败时页面仍保持摸鱼样式 */
  async function applyWindow() {
    const my = ++seq
    try {
      const result = await enterStealthWindow(settings.stealth, t('stealth.defaultTitle'))
      if (my === seq) settleWindow()
      return my === seq ? result : null
    } catch (e) {
      logEvent('warn', 'stealth', `enter failed: ${errText(e)}`)
      if (my === seq) toast(t('stealth.windowFailed'), 'error')
      return null
    }
  }

  /**
   * 等窗口尺寸稳定下来再通知阅读页: 去边框、套用位置大小、WebView2 跟着改尺寸是几步异步的,
   * 固定等 320ms 有时还没改完 (2026-11-08 Win10 大窗口进入时位置核对早于重排)。
   * 尺寸连续 250ms 不变 (至少等 320ms, 最多 2.5s) 后, 再等一帧。
   */
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * 诊断: 摸鱼窗口右下角偶有约 16px 的不透明白块 (2026-11-08 Win10 第 2 轮, 调尺寸后出现),
   * 像是没套上细滚动条样式的滚动条交角。记下此刻带滚动条的元素和指针类型, 同样的结果只记一次。
   */
  let lastScrollbars = ''
  function reportScrollbars() {
    const found: string[] = []
    for (const el of [document.documentElement, document.body, ...document.querySelectorAll('body *')] as HTMLElement[]) {
      const v = el.offsetWidth - el.clientWidth, h = el.offsetHeight - el.clientHeight
      if (el.clientWidth && (v > 2 || h > 2) && getComputedStyle(el).borderStyle === 'none') {
        found.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} ${v}x${h}`)
      }
    }
    const sig = `${matchMedia('(pointer: fine)').matches ? 'fine' : 'not-fine'} ${window.innerWidth}x${window.innerHeight} [${found.slice(0, 6).join(', ')}]`
    if (found.length && sig !== lastScrollbars) logEvent('info', 'stealth', `scrollbars ${sig}`)
    lastScrollbars = sig
  }
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const onResize = () => {
    if (!active.value) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(reportScrollbars, 500)
  }
  function settleWindow() {
    clearTimeout(settleTimer)
    const started = Date.now()
    let last = ''
    let stableSince = started
    const tick = () => {
      const now = Date.now()
      const size = `${window.innerWidth}x${window.innerHeight}`
      if (size !== last) {
        last = size
        stableSince = now
      }
      if ((now - stableSince >= 250 && now - started >= 320) || now - started >= 2500) {
        requestAnimationFrame(() => {
          hooks.windowChanged?.()
          if (active.value) reportScrollbars()
        })
      } else {
        settleTimer = setTimeout(tick, 60)
      }
    }
    settleTimer = setTimeout(tick, 60)
  }

  async function set(on: boolean) {
    if (!available || on === active.value) return
    if (on) await hooks.beforeEnter?.()
    active.value = on
    document.documentElement.classList.toggle('lr-stealth', on)
    // 进入时焦点若还在工具栏的输入框 (如 PDF 页码), 摸鱼里它被藏起来了却仍收着按键: 交还给页面 (R3 feature O01)
    if (on && document.activeElement instanceof HTMLInputElement) document.activeElement.blur()
    hooks.changed?.(on)
    if (on) {
      const result = await applyWindow()
      if (!active.value || !result) return
      bossKeyOk.value = result.bossKey
      const key = bossKeyLabel(settings.stealth.bossKey)
      if (result.bossKeyError) {
        logEvent('warn', 'stealth', `boss key ${settings.stealth.bossKey} failed: ${errText(result.bossKeyError)}`)
        toast(t('stealth.bossKeyFailed', { key }), 'error')
      }
      // 第一次进入: 说明卡讲清老板键 / Esc / 顶部细条; 之后只把顶部细条展开几秒 (StealthStrip peek), 不弹提示框挡正文
      if (!settings.stealth.introSeen) intro.value = true
    } else {
      seq++
      intro.value = false
      await exitWindow()
      hooks.afterExit?.()
      settleWindow()
    }
  }

  /** 退出原生摸鱼窗口, 记下这次摸鱼的位置大小 */
  async function exitWindow() {
    try {
      const bounds = await exitStealthWindow()
      if (bounds) settings.stealth.bounds = bounds
    } catch (e) {
      logEvent('warn', 'stealth', `exit failed: ${errText(e)}`)
    }
  }

  function dismissIntro() {
    intro.value = false
    settings.stealth.introSeen = true
  }

  const toggle = () => void set(!active.value)

  /** 书打开后调用: 设置了「打开图书时自动进入」就进入 */
  function autoEnter() {
    if (available && settings.stealth.autoEnter) void set(true)
  }

  // 摸鱼中改了伪装标题 / 置顶 / 老板键: 立即应用到窗口 (浓淡只影响页面, 不必调原生)
  watch(
    () => [settings.stealth.disguise, settings.stealth.disguiseTitle, settings.stealth.alwaysOnTop, settings.stealth.bossKey, settings.stealth.skipTaskbar, settings.stealth.hideFromCapture].join('|'),
    () => { if (active.value) void applyWindow() },
  )

  /**
   * Esc 退出; 处理了返回 true, 阅读页不再处理这次按键 (否则还会关面板 / 停自动翻页)。
   * 顶层窗口在捕获阶段自动处理; 正文 iframe 里的按键不经过这里, 阅读页的按键处理需先调用它。
   */
  function handleKey(e: KeyboardEvent): boolean {
    if (!active.value || e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false
    e.preventDefault()
    e.stopImmediatePropagation()
    // 说明卡开着时 Esc 先关说明卡
    if (intro.value) dismissIntro()
    else void set(false)
    return true
  }
  const onKeydown = (e: KeyboardEvent) => { handleKey(e) }

  onMounted(() => {
    if (!available) return
    window.addEventListener('keydown', onKeydown, true)
    window.addEventListener('resize', onResize)
    void onBossKey(hidden => { if (hidden && active.value) hooks.bossHidden?.() })
      .then(stop => { stopBossListen = stop })
      .catch(() => {})
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('resize', onResize)
    clearTimeout(resizeTimer)
    stopBossListen?.()
    clearTimeout(settleTimer)
    if (active.value) {
      seq++
      active.value = false
      document.documentElement.classList.remove('lr-stealth')
      void exitWindow()
    }
  })

  return { available, active, intro, bossKeyOk, dismissIntro, set, toggle, autoEnter, handleKey }
}
