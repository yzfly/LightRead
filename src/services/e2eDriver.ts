/**
 * 模拟器验收用的遥控通道 (docs/testing/ios-simulator.md)。iOS 模拟器没有可编程的触摸输入,
 * 用这条通道按元素点击、读页面状态、导入样书; 截图由 `xcrun simctl io` 完成。
 *
 * 只在构建时设了 LIGHTREAD_E2E_DRIVER=<地址> 才会被打进包 (vite define `__E2E_DRIVER__`),
 * 正式构建里这个常量是空串, 整个模块不进产物。通道能执行任意脚本, 绝不能出现在发布包里:
 * scripts/check-release.mjs 发版时拒绝带这个环境变量。
 */
import { logEvent } from './diagnostics'

type Helpers = ReturnType<typeof helpers>

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function visible(el: Element) {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
}

function helpers(base: string, http: typeof fetch) {
  const q = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(visible) ?? null
  /** 按可见文字找元素 (取最深的那个); tag 缺省不限 */
  const byText = (text: string, tag = '*') => {
    const all = [...document.querySelectorAll<HTMLElement>(tag)].filter(el => visible(el) && el.textContent?.trim() === text)
    return all.find(el => !all.some(other => other !== el && el.contains(other))) ?? null
  }
  const wait = async <T>(probe: () => T | null | undefined | false, timeout = 15_000): Promise<T> => {
    const end = Date.now() + timeout
    for (;;) {
      const value = probe()
      if (value) return value
      if (Date.now() > end) throw new Error(`timeout waiting for ${String(probe).slice(0, 120)}`)
      await sleep(100)
    }
  }
  const find = (target: string) => q(target) ?? byText(target)
  return {
    q, byText, wait, sleep,
    /** 选择器或可见文字; 找不到就等 */
    async click(target: string, timeout = 15_000) {
      const el = await wait(() => { try { return find(target) } catch { return byText(target) } }, timeout)
      el.scrollIntoView({ block: 'center' })
      el.click()
      await sleep(250)
    },
    /** 在视口坐标处模拟一次轻点 (阅读页的轻点分区认指针事件, 不认 click()) */
    async tap(x: number, y: number) {
      const el = document.elementFromPoint(x, y)
      if (!el) throw new Error(`nothing at ${x},${y}`)
      const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true }
      el.dispatchEvent(new PointerEvent('pointerdown', init))
      el.dispatchEvent(new PointerEvent('pointerup', init))
      el.dispatchEvent(new MouseEvent('click', init))
      await sleep(250)
    },
    /** 从遥控端的 /files/<name> 取样书, 经书架的文件选择框导入 (与用户选文件同一条路) */
    async importBook(name: string) {
      const response = await http(`${base}/files/${encodeURIComponent(name)}`)
      if (!response.ok) throw new Error(`fetch ${name}: ${response.status}`)
      const file = new File([await response.arrayBuffer()], name)
      const input = await wait(() => document.querySelector<HTMLInputElement>('input[type=file]:not([webkitdirectory])'))
      const transfer = new DataTransfer()
      transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return file.size
    },
    /** 页面概况: 路由、标题、可见按钮文字 */
    summary() {
      return {
        route: location.hash,
        viewport: [innerWidth, innerHeight],
        theme: document.documentElement.dataset.theme ?? '',
        headings: [...document.querySelectorAll('h1,h2')].filter(visible).map(el => el.textContent?.trim()).slice(0, 8),
        buttons: [...document.querySelectorAll('button,[role=button],a')].filter(visible)
          .map(el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 24)).filter(Boolean).slice(0, 60),
      }
    },
  }
}

export async function startE2eDriver(base: string) {
  const { fetch: http } = await import('@tauri-apps/plugin-http')
  const h: Helpers = helpers(base, http as typeof fetch)
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (h: Helpers) => Promise<unknown>
  const errors: string[] = []
  let reported = false
  window.addEventListener('error', e => errors.push(String(e.message)))
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)))
  for (;;) {
    try {
      const response = await http(`${base}/next`)
      if (response.status !== 200) { await sleep(300); continue }
      const job: { id: number; code: string } = await response.json()
      let result: Record<string, unknown>
      try {
        result = { id: job.id, ok: true, value: await new AsyncFunction('h', job.code)(h) ?? null }
      } catch (e) {
        result = { id: job.id, ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) }
      }
      result.errors = errors.splice(0)
      let body: string
      try { body = JSON.stringify(result) } catch { body = JSON.stringify({ id: job.id, ok: false, error: 'result is not JSON-serializable' }) }
      await http(`${base}/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    } catch (e) {
      if (!reported) { reported = true; logEvent('warn', 'e2e-driver', String(e)) }
      await sleep(1000)
    }
  }
}
