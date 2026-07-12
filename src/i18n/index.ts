/**
 * 轻量 i18n: 无外部依赖的纯函数翻译。
 * - 按 settings.language 选字典, en 缺失回退 zh, 再回退 key 本身
 * - t() 在组件 render 中读取 pinia 响应式 state, 语言切换自动触发重渲染
 * - 惰性获取 store: 模块可在 pinia 初始化前被 import (服务层), 首次调用时再取
 */
import { useSettings } from '../stores/settings'
import zh from './zh'
import en from './en'

const dicts: Record<'zh' | 'en', Record<string, string>> = { zh, en }

let settings: ReturnType<typeof useSettings> | null = null

function currentLang(): 'zh' | 'en' {
  if (!settings) {
    try {
      settings = useSettings()
    } catch {
      // pinia 尚未就绪 (模块加载早于 app.use(pinia)), 回退中文
      return 'zh'
    }
  }
  return settings.language === 'en' ? 'en' : 'zh'
}

export function t(key: string, params?: Record<string, string | number>): string {
  const lang = currentLang()
  let text = dicts[lang][key] ?? dicts.zh[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}
