import { shallowRef } from 'vue'
import { t } from '../i18n'

export interface ConfirmOptions {
  /** 弹窗标题, 默认「确认」 */
  title?: string
  /** 确认按钮文字, 默认「确认」; 删除类写「删除」 */
  confirmLabel?: string
  /** 不可恢复的操作: 确认按钮用危险色 */
  danger?: boolean
}
interface Confirmation extends ConfirmOptions { message: string; resolve: (accepted: boolean) => void }
export const confirmation = shallowRef<Confirmation | null>(null)
/** App-owned confirmation; dismissing or leaving the page always cancels. */
export function askConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (confirmation.value) return Promise.resolve(false)
  return new Promise(resolve => { confirmation.value = { ...options, message, resolve } })
}
/** 删除类确认: 红色「删除」按钮, 默认焦点仍在取消 */
export function deleteConfirmOptions(title?: string): ConfirmOptions {
  return { title, confirmLabel: t('common.delete'), danger: true }
}
export function settleConfirmation(accepted: boolean) {
  const current = confirmation.value
  confirmation.value = null
  current?.resolve(accepted)
}
