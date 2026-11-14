/**
 * 本机对话模型 (Qwen3.5, 经 llama.cpp; 原生层 src-tauri/src/local_llm) 的纯函数与常量:
 * 「AI 服务」里的「本机模型」用哪个模型、消息怎么裁进上下文。不依赖 Vue / 浏览器 API。
 */

/** settings.aiProvider 的取值: 阅读助手在本机运行, 不联网 */
export const LOCAL_AI_PROVIDER = 'local'
/** 占位地址 (不会被请求): 让依赖 aiBaseUrl 非空的旧判断照常工作 */
export const LOCAL_AI_BASE_URL = 'local://lightread'
/** 低于它算慢 (token/秒): 界面建议换小一档的模型 */
export const LOCAL_CHAT_SLOW_TPS = 6
/** 一次回答最多生成多少 token (调用方没指定时) */
export const LOCAL_CHAT_MAX_TOKENS = 768

/** 本机模型状态里与对话有关的几项 (services/localLlm.ts 的 LocalModel) */
export interface LocalChatModel {
  id: string
  kind: string
  size: number
  installed: boolean
  supported: boolean
  crashed: boolean
  recommended?: boolean
  speed: number | null
}

/** 对话模型, 由小到大 */
export function chatModels<T extends LocalChatModel>(models: T[]): T[] {
  return models.filter(m => m.kind === 'chat').sort((a, b) => a.size - b.size)
}

const usable = (m: LocalChatModel) => m.installed && !m.crashed

/**
 * 这次对话用哪个模型: 用户选的那个 (已下载且没因闪退停用), 否则已下载的里面推荐的, 再否则最小的。
 * 一个都没下载返回 undefined。
 */
export function pickChatModel<T extends LocalChatModel>(models: T[], preferred: string): T | undefined {
  const ready = chatModels(models).filter(usable)
  return ready.find(m => m.id === preferred) ?? ready.find(m => m.recommended) ?? ready[0]
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 长文本留头留尾 (问题常在末尾, 背景在开头) */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.ceil(limit * 0.6)
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (limit - head))}`
}

/**
 * 把消息裁进本机模型的上下文: 保留系统提示与最后一条 (当前问题), 历史对话从最近的往前留, 装不下的丢掉。
 * `budget` 是字符数 (中文约一字一个 token, 调用方按上下文大小留出回答的余量)。
 */
export function fitChatMessages(messages: ChatTurn[], budget: number): ChatTurn[] {
  const list = messages.filter(m => m.content.trim())
  if (!list.length) return []
  const system = list[0].role === 'system' ? list[0] : null
  const rest = system ? list.slice(1) : list
  const last = rest[rest.length - 1]
  if (!last) return system ? [{ role: 'user', content: clip(system.content, budget) }] : []
  const out: ChatTurn[] = []
  let left = budget
  const sys = system ? { ...system, content: clip(system.content, Math.floor(budget * 0.3)) } : null
  if (sys) left -= sys.content.length
  const tail = { ...last, content: clip(last.content, Math.max(200, left)) }
  left -= tail.content.length
  for (let i = rest.length - 2; i >= 0; i--) {
    const turn = rest[i]
    if (turn.content.length > left) break
    out.unshift(turn)
    left -= turn.content.length
  }
  // 历史要从用户的话开始: 开头孤零零的一句助手回答对模型没有意义
  while (out.length && out[0].role !== 'user') out.shift()
  return [...(sys ? [sys] : []), ...out, tail]
}

/** 按上下文大小 (token) 给出消息的字符预算: 留出回答与模板的余量 */
export function chatCharBudget(nCtx: number, maxTokens: number): number {
  return Math.max(600, Math.floor((nCtx - maxTokens - 96) * 0.9))
}

/** 模型偶尔仍写出思考块: 去掉 (流式时前缀可能只到一半, 由调用方在拿到完整文本后再清一次) */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/^\s*<\/think>\s*/, '')
}
