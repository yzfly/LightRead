/**
 * 判断异常是不是 wasm 引擎崩溃 (Emscripten abort / wasm trap)。
 * 崩溃后实例的栈指针和堆状态都不可信, 继续用同一实例, 之后任何文件都只会报
 * memory access out of bounds, 所以必须换新实例。
 */
export function isWasmCrash(error: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) return true
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? error ?? '')
  return /^(RuntimeError: )?(Aborted\(|memory access out of bounds|unreachable|table index is out of bounds|indirect call|null function|float unrepresentable|divide by zero|integer overflow)/i.test(message)
    || message.includes('native code called abort')
}
