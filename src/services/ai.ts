/**
 * 阅读 AI 助手: 统一走 OpenAI 兼容的 chat/completions 接口。
 *  - 预设: 硅基流动 (免费模型) / 智谱 GLM-4-Flash (免费) / 豆包 (火山方舟) /
 *    本地 Ollama / 自定义
 *  - 桌面端经 Rust HTTP (支持代理, 无 CORS 限制), Web 端直接 fetch
 *  - SSE 流式输出
 */
import { fetchRemote } from './net'
import { useSettings } from '../stores/settings'

export interface AiProviderPreset {
  id: string
  /** 展示名 (含免费标注) */
  label: string
  baseUrl: string
  defaultModel: string
  /** 是否需要 API Key */
  needsKey: boolean
  /** 申请 Key 的入口 */
  docsUrl?: string
}

export const AI_PROVIDERS: AiProviderPreset[] = [
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    needsKey: true,
    docsUrl: 'https://cloud.siliconflow.cn/i/TxUlXG3u',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    needsKey: true,
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'qwen',
    label: '阿里云千问 (百炼)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    needsKey: true,
    docsUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'kimi',
    label: 'Kimi (月之暗面)',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    needsKey: true,
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'doubao',
    label: '豆包 (火山方舟)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    needsKey: true,
    docsUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'ollama',
    label: '本地模型 (Ollama)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    needsKey: false,
  },
  {
    id: 'custom',
    label: 'OpenAI 兼容自定义',
    baseUrl: '',
    defaultModel: '',
    needsKey: false,
  },
]

export const providerById = (id: string) =>
  AI_PROVIDERS.find(p => p.id === id) ?? AI_PROVIDERS[0]

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** AI 是否已完成必要配置 */
export function aiConfigured(): boolean {
  const s = useSettings()
  const preset = providerById(s.aiProvider)
  if (!s.aiBaseUrl.trim() || !s.aiModel.trim()) return false
  if (preset.needsKey && !s.aiApiKey.trim()) return false
  return true
}

/**
 * 流式对话。逐段 yield 增量文本; 非 2xx 时抛出带服务端信息的错误。
 * 服务端不支持流式时回退整段返回。
 */
export async function* chatStream(messages: AiMessage[]): AsyncGenerator<string> {
  const s = useSettings()
  const url = s.aiBaseUrl.trim().replace(/\/+$/, '') + '/chat/completions'
  const res = await fetchRemote(url, undefined, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
      ...(s.aiApiKey.trim() ? { authorization: `Bearer ${s.aiApiKey.trim()}` } : {}),
    },
    body: JSON.stringify({
      model: s.aiModel.trim(),
      messages,
      stream: true,
      temperature: 0.6,
    }),
    raw: true,
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`${res.status} ${text || res.statusText}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  // 服务端不支持流式 (返回整段 JSON)
  if (contentType.includes('application/json')) {
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (content) yield String(content)
    return
  }

  const reader = res.body?.getReader?.()
  if (!reader) {
    const data = JSON.parse(await res.text())
    const content = data?.choices?.[0]?.message?.content
    if (content) yield String(content)
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content
        if (delta) yield String(delta)
      } catch { /* 跳过无法解析的行 (注释/心跳) */ }
    }
  }
}

/** 阅读场景的系统提示 */
export function readerSystemPrompt(book: { title?: string; author?: string }, chapter: string, lang: 'zh' | 'en'): string {
  const zh = `你是一位博学的阅读助手。用户正在阅读《${book.title ?? ''}》${book.author ? `(${book.author})` : ''}${chapter ? `, 当前章节:「${chapter}」` : ''}。请围绕这本书回答问题, 补充历史背景、人物关系、典故出处等知识。回答简洁准确, 分点或短段落, 不要空话。`
  const en = `You are a knowledgeable reading companion. The user is reading "${book.title ?? ''}"${book.author ? ` by ${book.author}` : ''}${chapter ? `, currently in chapter "${chapter}"` : ''}. Answer questions around this book with background, context and references. Be concise and accurate.`
  return lang === 'en' ? en : zh
}

/** 划词解读的提问模板 */
export function explainPrompt(text: string, lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? `Please explain this passage: its meaning, background, and any allusions or context worth knowing.\n\n"${text}"`
    : `请解读下面这段文字: 含义、历史背景、涉及的人物或典故, 以及值得展开的知识点。\n\n「${text}」`
}
