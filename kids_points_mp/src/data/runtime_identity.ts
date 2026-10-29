import { isValidDeviceId } from './device_identity'

/**
 * **运行期**身份上下文（W9-B / `40` §10.1）。
 *
 * ── 它修的是什么 ────────────────────────────────────────────────────────────
 *   W9 之前，`x-kp-device-id` / `x-kp-child-id` 两个头都来自**编译期常量**
 *   （`ReadApiConfig` 从 `TARO_APP_KP_DEVICE_ID` / `TARO_APP_KP_CHILD_ID` 读）。
 *   登录链路把 `childId` 变成了**运行期才知道**的东西：
 *   `GET /auth/session` 之前客户端根本不知道自己在这个账号上有哪个孩子。
 *   若仍只认编译期值，新用户登录成功后**一个业务请求都发不出去**。
 *
 * ── 为什么不直接改 `ReadApiConfig` 的字段 ────────────────────────────────────
 *   四个客户端（`read_api` / `write_api` / `onboarding` / `parent_mode`）都在
 *   `AppStore` 构造时一次性建好，而登录发生在之后。把运行期值塞进 config
 *   只能靠"重建四个客户端 + 换掉 store 里所有引用"；而放一个共享持有者，
 *   头是**每次请求现读**的 —— 登录成功那一刻起，四个客户端同时生效。
 *   （与 `auth_token_holder.ts` 同一种手法，理由也一样。）
 *
 * ── 优先级 ──────────────────────────────────────────────────────────────────
 *   运行期值（登录后）> 编译期值（开发期手工复现）。
 *   这样 `TARO_APP_KP_CHILD_ID` 仍然是"没登录时也能连本地后端"的调试通道，
 *   而一旦登录成功，服务端下发的孩子必须**覆盖**它 —— 否则会出现
 *   "登录到了 A 账号，请求却打到编译期写死的 B 孩子上"。
 *
 * ── ★ 它不是凭据 ────────────────────────────────────────────────────────────
 *   身份来自 `Authorization: Bearer`，角色来自成员位（`40` §3）。
 *   这两个头只是"在哪个孩子的档案上"的选择器，伪造它们换不到任何权限。
 */
export interface RuntimeIdentity {
  deviceId: string
  childId: string
}

export class RuntimeDeviceContext {
  private deviceIdValue: string | null = null
  private childIdValue: string | null = null

  /** 运行期 deviceId；没登录过（也没有手工设置）时 null。 */
  deviceId(): string | null {
    return this.deviceIdValue
  }

  /** 运行期 childId；没有当前孩子时 null。 */
  childId(): string | null {
    return this.childIdValue
  }

  /**
   * 一次会话就绪：同时装两个值。
   *
   * 校验与 `device_identity.isValidDeviceId` / 后端 Guard 同口径：
   * 非法值会让请求头在传输层被截断，宁可当场抛错，也不要发出一个
   * 后端会静默 trim 成别的值的头。
   */
  apply(input: RuntimeIdentity): void {
    const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : ''
    if (!isValidDeviceId(deviceId)) {
      throw new Error(`运行期 deviceId 不合法：${String(input.deviceId)}`)
    }
    const childId = normalizeChildId(input.childId)
    this.deviceIdValue = deviceId
    this.childIdValue = childId
  }

  /**
   * 只换孩子（将来的"切换孩子"）：deviceId 保持不变。
   *
   * 没有 deviceId 时**不改**任何值并返回 false —— 调用方据此知道
   * "还没登录过，不能只换孩子"，而不是得到一个半边状态。
   */
  applyChild(rawChildId: string): boolean {
    const childId = normalizeChildId(rawChildId)
    if (this.deviceIdValue === null) return false
    this.childIdValue = childId
    return true
  }

  /**
   * 登出：**只清孩子**。
   *
   * 刻意保留 deviceId：它是设备标识而不是凭据（`40` §9.2）。
   * 清掉它会让同一台手机在下次登录时变成"另一台设备" —— 后端
   * `DeviceSession` 的行键是 `(deviceId, childId)`，历史会一层层堆起来。
   */
  clearChild(): void {
    this.childIdValue = null
  }

  /** 冷启动 / 用例复位：两者都清。 */
  reset(): void {
    this.deviceIdValue = null
    this.childIdValue = null
  }

  /** 当前快照（没有完整身份时 null）—— 只给诊断 / 用例用。 */
  snapshot(): RuntimeIdentity | null {
    if (this.deviceIdValue === null || this.childIdValue === null) return null
    return { deviceId: this.deviceIdValue, childId: this.childIdValue }
  }

  /** ★ 不输出 childId 之外的任何东西；这是会进调试器/日志的对象。 */
  toString(): string {
    if (this.deviceIdValue === null) return 'RuntimeDeviceContext(<empty>)'
    return this.childIdValue === null
      ? 'RuntimeDeviceContext(<device only>)'
      : 'RuntimeDeviceContext(<device+child>)'
  }
}

/**
 * childId 的校验：非空、无空白。
 *
 * 不做 cuid 形状校验 —— 那是服务端 `AuthSession` / `Child.id` 的事；
 * 客户端再写一份正则只会变成第二份真相（与 `auth_token_holder` 的口径一致）。
 */
function normalizeChildId(raw: unknown): string {
  const childId = typeof raw === 'string' ? raw.trim() : ''
  if (childId === '') {
    throw new Error('childId 不能为空：没有当前孩子时请用 clearChild()。')
  }
  if (/\s/.test(childId)) {
    throw new Error('childId 里不能有空白字符（请求头会被截断/判定非法）。')
  }
  return childId
}

/**
 * 全进程唯一的那一个（与 `sharedAuthTokens` 同一手法）。
 *
 * 小程序没有多账号并存（一台设备一个微信），而"两个页面各持一份身份"
 * 正是"退出后还能点"和"请求打到上一个孩子"的来源。测试里直接 `reset()`。
 */
export const sharedDeviceContext = new RuntimeDeviceContext()
