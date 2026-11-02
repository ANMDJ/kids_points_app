import { Injectable, NotImplementedException } from '@nestjs/common'

import type { IdentifierType } from './account-identifier'

/**
 * **网站注册邀请码**的持久化端口（W12，2026-11-02 /
 * `docs/design/48-public-invite-acquisition.md` §2）。
 *
 * ── 与 `InviteRegistrationPort` 的差别（只有一处，但很关键）───────────────
 *   那条路是「加入一个**已存在**的家庭」：一个事务里写 `User` + 占家庭码 +
 *   `ChildMember` + `DeviceSession` + `AuthSession` + 审计。
 *   这条路是「**凭空建一个账号**」：只写 `User` + 占网站码 + `AuthSession` + 审计。
 *   ⇒ **不建 `ChildMember`，也不建 `DeviceSession`**：
 *     新账号此刻零个孩子，客户端会走既有的 `POST /children` 引导。
 *     若在这里硬造一个孩子，就回到了 `42` §5.1 拒绝的「孤儿家庭」。
 *
 * ── 为什么单独一个端口，而不是给 `InviteRegistrationPort` 加参数 ────────────
 *   两个方法的**事务内容不同**（差两张表），合并只会让每个替身都要处理
 *   「这次走哪条路」的分支。`identity.repository.ts` 文件头警告过接口面
 *   变宽的代价，这里沿用同一条纪律。
 */
export const PUBLIC_REGISTRATION_REPOSITORY = Symbol('PUBLIC_REGISTRATION_REPOSITORY')

export interface RegisterWithPublicInviteInput {
  /** **已规范化**的邀请码（`normalizeInviteCode()` 的输出，不含连字符）。 */
  code: string
  /** 服务端分类结果（`classifyIdentifier()`）。 */
  identifierType: IdentifierType
  /** **已规范化**的标识（手机号 `1[3-9]\d{9}` / 邮箱全小写）。 */
  identifierValue: string
  /** `scrypt-pw$…` 自描述串（端口不接收明文）。 */
  passwordHash: string
  displayName: string | null
  /** 设备标识：只进 `AuthSession.deviceId` 与审计，**不是**凭据。 */
  deviceId: string
  /** **已哈希**的认证 token（端口不接收明文）。 */
  tokenHash: string
  /** `AuthSession.expiresAt`（7 天绝对）。 */
  authExpiresAt: Date
}

export interface RegisteredPublicRow {
  userId: string
  displayName: string | null
}

export interface PublicRegistrationPort {
  registerWithInvite(input: RegisterWithPublicInviteInput): Promise<RegisteredPublicRow>
}

/**
 * **无库装配**：501，绝不「假装注册成功」。
 *
 * 回一个 token 出去会让客户端以为已经登录，而下一次请求必然 401 ——
 * 用户会在「注册成功」与「请重新登录」之间无限循环，而病是装配。
 */
@Injectable()
export class NotImplementedPublicRegistrationRepository implements PublicRegistrationPort {
  async registerWithInvite(_input: RegisterWithPublicInviteInput): Promise<RegisteredPublicRow> {
    throw new NotImplementedException({
      code: 'PUBLIC_REGISTRATION_NOT_IMPLEMENTED',
      message:
        '当前进程没有 DATABASE_URL（无库装配）⇒ 网站邀请码注册不可用：registerWithInvite 没有实现。' +
        '★ 拒绝而不是假装成功：回一个 token 出去会让客户端以为注册完成，而下一次请求必然 401。'
    })
  }
}
