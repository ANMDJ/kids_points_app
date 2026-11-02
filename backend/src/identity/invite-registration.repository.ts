import { Injectable, NotImplementedException } from '@nestjs/common'

import type { InviteRole } from '../invites/invites.types'
import type { IdentifierType } from './account-identifier'

/**
 * **邀请注册**的持久化端口（W11-A，2026-11-02 / `docs/design/45-invite-registration.md` §2）。
 *
 * ── 它解决的是哪一个洞 ──────────────────────────────────────────────────────
 *   `42` §5.1 明确「App 首版不开放注册」，理由不是懒，而是：手机号打错一位
 *   就会静默生成一个新账号，用户进去发现「我的孩子不见了」。而 `42` §9 第 1 条
 *   写了补上它的**前置条件**：**邀请码并入家庭**。本端口就是那个前置条件。
 *
 *   邀请码把「注册」从「凭空造一个新家庭」变成「加入一个**已经存在**的家庭」：
 *     · 打错手机号 ⇒ 得到一个加入了**正确家庭**的新账号（不是孤儿账号）；
 *       而他仍然可以用正确号码再注册一次（被 409 挡住，提示去登录）；
 *     · 没有邀请码 ⇒ 端点直接拒绝 ⇒ 不能自助注册 ⇒ 没有「开放注册」的滥用面。
 *
 * ── 为什么单独一个端口，而不是给 `IdentityPort` 加第 9 个方法 ────────────────
 *   `IdentityPort` 的 7 个方法每个都有 2 个测试替身（`account-login-http`、
 *   `identity-http`）。加一个方法 = 一次性改 4 个替身，而其中 3 个永远用不到它
 *   —— 那正是 `identity.repository.ts` 文件头警告的「接口面变宽 ⇒ 替身越来越难写」。
 *
 * ── 一个事务，五张表（顺序不能换）──────────────────────────────────────────
 *   ① `User`（手机号/邮箱 + 密码哈希）；
 *   ② 原子占邀请码（`invite-claim.ts`，**唯一**的「还能不能用」判据）；
 *   ③ `ChildMember`（角色来自邀请码，**不**来自请求体）；
 *   ④ `DeviceSession`（这台设备在这个孩子上的会话）；
 *   ⑤ `AuthSession`（认证凭据，明文只在响应里出现一次）。
 *   任何一步失败都必须**整笔回滚**：否则会出现「账号建了、码没占上」「码占了、
 *   人没加进去」这类半成品，而用户看到的是 500/409，重试又是另一个半成品。
 */
export const INVITE_REGISTRATION_REPOSITORY = Symbol('INVITE_REGISTRATION_REPOSITORY')

export interface RegisterWithInviteInput {
  /** **已规范化**的邀请码（`normalizeInviteCode()` 的输出，不含连字符）。 */
  code: string
  /** 服务端分类结果（`classifyIdentifier()`），客户端不指定「我要用手机还是邮箱」。 */
  identifierType: IdentifierType
  /** **已规范化**的标识（手机号 `1[3-9]\d{9}` / 邮箱全小写）。 */
  identifierValue: string
  /** `scrypt-pw$…` 自描述串（`common/password-hash.ts`），端口不接收明文。 */
  passwordHash: string
  /** 家长自己填的称呼；`null` ⇒ 不采集（`User.displayName` 可空）。 */
  displayName: string | null
  /** 设备标识：`DeviceSession` 的行键之一，**不是**凭据。 */
  deviceId: string
  /** **已哈希**的认证 token（端口不接收明文）。 */
  tokenHash: string
  /** `AuthSession.expiresAt`（7 天绝对）。 */
  authExpiresAt: Date
  /** `DeviceSession.expiresAt`（与邀请码加入同口径：30 天）。 */
  deviceSessionExpiresAt: Date
}

export interface RegisteredInviteRow {
  userId: string
  displayName: string | null
  childId: string
  /** 来自**邀请码**的角色，不是请求体里的任何字段。 */
  role: InviteRole
}

export interface InviteRegistrationPort {
  registerWithInvite(input: RegisterWithInviteInput): Promise<RegisteredInviteRow>
}

/**
 * **无库装配**：501，绝不「假装注册成功」。
 *
 * 回一个 token 出去会让客户端以为已经登录，而下一次请求（守卫查 `AuthSession`）
 * 必然 401 —— 用户会在「注册成功」与「请重新登录」之间无限循环，而病是装配。
 */
@Injectable()
export class NotImplementedInviteRegistrationRepository implements InviteRegistrationPort {
  async registerWithInvite(_input: RegisterWithInviteInput): Promise<RegisteredInviteRow> {
    throw new NotImplementedException({
      code: 'INVITE_REGISTRATION_NOT_IMPLEMENTED',
      message:
        '当前进程没有 DATABASE_URL（无库装配）⇒ 邀请码注册不可用：registerWithInvite 没有实现。' +
        '★ 拒绝而不是假装成功：回一个 token 出去会让客户端以为注册完成，而下一次请求必然 401。'
    })
  }
}
