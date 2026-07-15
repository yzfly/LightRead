/**
 * 运行时 polyfill: 补齐 WKWebView (Safari 内核) 缺失的标准特性。
 *
 * ReadableStream 异步迭代器 — 系统 WKWebView 缺少 Symbol.asyncIterator,
 * 任何依赖 `for await (const v of readableStream)` 的库都会抛
 * "undefined is not a function" (曾导致 pdf.js 时代论文段落提取整页失败)。
 * 保留以兜底第三方依赖。
 */
const rs = typeof ReadableStream !== 'undefined' ? (ReadableStream.prototype as any) : null

if (rs && !rs[Symbol.asyncIterator]) {
  if (!rs.values) {
    rs.values = function (this: ReadableStream, { preventCancel = false } = {}) {
      const reader = this.getReader()
      return {
        async next() {
          try {
            const result = await reader.read()
            if (result.done) reader.releaseLock()
            return result
          } catch (e) {
            reader.releaseLock()
            throw e
          }
        },
        async return(value?: unknown) {
          if (preventCancel) {
            reader.releaseLock()
          } else {
            const cancel = reader.cancel(value)
            reader.releaseLock()
            await cancel
          }
          return { done: true as const, value }
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
    }
  }
  rs[Symbol.asyncIterator] = function () {
    return this.values()
  }
}
