/**
 * 批量设置标签的输入框: 读者既能手输 (逗号 / 顿号分隔), 也能点选已有标签 (2026-11-23 读者反馈)。
 * 点选只改输入框里的文字, 两种方式结果一致, 提交时统一按 parseTagDraft 拆分。
 */
const SEPARATORS = /[,，、]/

export function parseTagDraft(draft: string): string[] {
  return [...new Set(draft.split(SEPARATORS).map(tag => tag.trim()).filter(Boolean))]
}

export function draftHasTag(draft: string, tag: string): boolean {
  return parseTagDraft(draft).includes(tag)
}

/** 点一下已有标签: 没写就加上, 已写就去掉; 其余手输内容原样保留 */
export function toggleTagInDraft(draft: string, tag: string): string {
  const tags = parseTagDraft(draft)
  const next = tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag]
  return next.join('，')
}
