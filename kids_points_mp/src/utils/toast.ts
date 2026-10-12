import Taro from '@tarojs/taro'

/**
 * 与原 Flutter 版 SnackBar 等价的轻提示。
 * 小程序没有悬浮 SnackBar，用 showToast（icon: 'none'）代替。
 */
export function toast(title: string): void {
  Taro.showToast({ title, icon: 'none', duration: 2000 })
}

export function successToast(title: string): void {
  Taro.showToast({ title, icon: 'success', duration: 1600 })
}

/** 确认弹窗，等价于 Flutter 的 AlertDialog。 */
export async function confirm(
  content: string,
  title = '提示',
  confirmText = '确定',
  cancelText = '取消'
): Promise<boolean> {
  const res = await Taro.showModal({
    title,
    content,
    confirmText,
    cancelText,
    confirmColor: '#7fbf55'
  })
  return Boolean(res.confirm)
}

/** 输入弹窗的选项与返回值：editable / content 是基础库 2.17.1 才有的能力。 */
interface EditableModalOption {
  title: string
  content: string
  placeholderText: string
  editable: boolean
  confirmText: string
  cancelText: string
  confirmColor: string
}

interface EditableModalResult {
  confirm: boolean
  content?: string
}

/**
 * Taro 的类型定义里 showModal 还没跟上这批新参数，
 * 这里单独声明一次调用签名，避免整段逻辑都写成 any。
 */
const showEditableModal = Taro.showModal as unknown as (
  option: EditableModalOption
) => Promise<EditableModalResult>

/** 文本输入弹窗（改昵称）。用户取消返回 null。 */
export async function prompt(
  title: string,
  value: string,
  placeholderText: string
): Promise<string | null> {
  const res = await showEditableModal({
    title,
    editable: true,
    content: value,
    placeholderText,
    confirmText: '保存',
    cancelText: '取消',
    confirmColor: '#7fbf55'
  })
  if (!res.confirm) return null
  return res.content ?? ''
}
