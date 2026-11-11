/**
 * PDF 页面渲染的主线程入口: 把 MuPDF 栅格化放进 Worker, 翻页与缩放时主线程只做一次上屏。
 *  - 一次只让 Worker 画一页, 其余在主线程排队: 当前页 (priority) 插到队首, 预载页排队尾,
 *    缩放后过期的请求可以用 drop() 整批作废, 不占 Worker 时间;
 *  - Worker 起不来 (旧 WebView / 产物加载失败) 时 create() 返回 null, 调用方走主线程回退;
 *  - 任何一次失败 (含 wasm 崩溃) 都结束 Worker 并让后续请求立即失败, 调用方回退 PDFium。
 */
import type { RasterRequest } from './raster.ts'

export interface RenderedPage {
  width: number
  height: number
  bitmap?: ImageBitmap
  pixels?: ArrayBuffer
}

interface Job {
  req: RasterRequest
  resolve: (page: RenderedPage) => void
  reject: (error: unknown) => void
}

export class PdfRenderDropped extends Error {
  constructor() {
    super('pdf render dropped')
    this.name = 'PdfRenderDropped'
  }
}

type WorkerFactory = () => Worker

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })

export class PdfRenderClient {
  #worker: Worker | null
  #seq = 0
  #queue: Job[] = []
  #active: { id: number; job: Job } | null = null
  #ready: Promise<void>
  #dead: Error | null = null

  private constructor(worker: Worker, bytes: ArrayBuffer) {
    this.#worker = worker
    worker.onmessage = e => this.#onMessage(e.data)
    worker.onerror = e => this.#fail(new Error(`pdf-render-worker: ${(e as ErrorEvent)?.message ?? 'error'}`))
    worker.onmessageerror = () => this.#fail(new Error('pdf-render-worker: message error'))
    this.#ready = new Promise<void>((resolve, reject) => {
      const id = ++this.#seq
      this.#loading = { id, resolve, reject }
      worker.postMessage({ id, type: 'load', bytes }, [bytes])
    })
    // 没人等 ready 时不要变成未处理的拒绝; render() 会自己报错
    this.#ready.catch(() => {})
  }

  #loading: { id: number; resolve: () => void; reject: (e: unknown) => void } | null = null

  /** bytes 会被转移给 Worker (调用后不可再用)。环境不支持 Worker 时返回 null, bytes 保持可用。 */
  static create(bytes: ArrayBuffer, factory: WorkerFactory = defaultFactory): PdfRenderClient | null {
    if (typeof Worker === 'undefined') return null
    let worker: Worker
    try {
      worker = factory()
    } catch (e) {
      console.warn('[pdf-render] worker unavailable, using main thread', e)
      return null
    }
    return new PdfRenderClient(worker, bytes)
  }

  get alive() {
    return !this.#dead
  }

  render(req: RasterRequest, opts: { priority?: boolean } = {}): Promise<RenderedPage> {
    if (this.#dead) return Promise.reject(this.#dead)
    return new Promise<RenderedPage>((resolve, reject) => {
      const job: Job = { req, resolve, reject }
      if (opts.priority) this.#queue.unshift(job)
      else this.#queue.push(job)
      void this.#pump()
    })
  }

  /** 作废还没开始画的请求 (比如缩放变了); 被作废的请求以 PdfRenderDropped 拒绝。 */
  drop(match: (req: RasterRequest) => boolean = () => true) {
    const keep: Job[] = []
    for (const job of this.#queue) {
      if (match(job.req)) job.reject(new PdfRenderDropped())
      else keep.push(job)
    }
    this.#queue = keep
  }

  close() {
    this.#fail(new Error('pdf render closed'))
  }

  async #pump() {
    if (this.#active || this.#dead) return
    try {
      await this.#ready
    } catch {
      return // #fail 已经拒绝了队列
    }
    if (this.#active || this.#dead) return
    const job = this.#queue.shift()
    if (!job) return
    const id = ++this.#seq
    this.#active = { id, job }
    this.#worker!.postMessage({ id, type: 'render', req: job.req })
  }

  #onMessage(msg: { id?: number; type?: string; message?: string } & Partial<RenderedPage>) {
    if (this.#loading && msg?.id === this.#loading.id) {
      const loading = this.#loading
      this.#loading = null
      if (msg.type === 'ok') loading.resolve()
      else this.#fail(new Error(msg.message || 'pdf render load failed'))
      return
    }
    const active = this.#active
    if (!active || msg?.id !== active.id) return
    if (msg.type !== 'ok') {
      // 一次渲染失败后 MuPDF 实例不再可信 (可能是 wasm 崩溃): 整个 Worker 作废
      this.#fail(new Error(msg.message || 'pdf render failed'))
      return
    }
    this.#active = null
    active.job.resolve({ width: msg.width!, height: msg.height!, bitmap: msg.bitmap, pixels: msg.pixels })
    void this.#pump()
  }

  #fail(error: Error) {
    if (this.#dead) return
    this.#dead = error
    this.#worker?.terminate()
    this.#worker = null
    this.#loading?.reject(error)
    this.#loading = null
    const waiting = [...(this.#active ? [this.#active.job] : []), ...this.#queue]
    this.#active = null
    this.#queue = []
    for (const job of waiting) job.reject(error)
  }
}

/** 把 Worker 交回的位图画进画布 (画布的 CSS 尺寸由调用方设好)。 */
export function paintRenderedPage(canvas: HTMLCanvasElement, page: RenderedPage) {
  canvas.width = page.width
  canvas.height = page.height
  const context = canvas.getContext('2d', { alpha: false })!
  if (page.bitmap) {
    context.drawImage(page.bitmap, 0, 0)
    page.bitmap.close()
  } else if (page.pixels) {
    context.putImageData(new ImageData(new Uint8ClampedArray(page.pixels), page.width, page.height), 0, 0)
  }
}
