/** 翻译上下文生成仍使用的通用流式问答桥。论文阅读 Agent 不走这里。 */
import { chatStream, type AiMessage } from './ai'

/**
 * 基于论文上下文的通用流式生成；目前由翻译上下文生成流程复用。
 * cancelled() 为真时中止。返回完整文本 (中止时为已生成部分)。
 */
export async function askDoc(
  system: string,
  history: AiMessage[],
  question: string,
  onDelta: (full: string) => void,
  cancelled: () => boolean,
  signal?: AbortSignal,
): Promise<string> {
  const messages: AiMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: question },
  ]
  let full = ''
  for await (const delta of chatStream(messages, signal)) {
    if (cancelled()) return full
    full += delta
    onDelta(full)
  }
  return full
}
