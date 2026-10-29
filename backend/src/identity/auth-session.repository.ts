import { Injectable, NotImplementedException } from '@nestjs/common'

import type { AuthMethod, AuthSessionRow } from './auth-session.gate'

/**
 * 认证会话的**持久化端口**（W9-A，2026-10-29 / `docs/design/40-login-and-session-design.md` §5、§9.3）。
 *
 * ── 它只做四件事（每个方法都是"一条语句能说清"的）────────────────────────────
 *   findByTokenHash  守卫每个请求都要问一次"这个 token 是谁"
 *   create           登录成功时签发（**只收哈希**，签名里没有明文参数）
 *   touch            更新 `lastSeenAt`（**不**延长 `expiresAt`，见 §4.3）
 *   revoke           退出登录（幂等：第二次撤销不报错）
 *
 * ── 为什么 `create` 的签名里没有 `token` ─────────────────────────────────────
 *   端口能接收明文，就总有一天有人把它写进日志或审计快照。调用方（service）
 *   必须已经 `hashToken()` 完 —— 与 `AuthPort.setParentPin` 只收 `pinHash` 同一纪律。
 *
 * ── 无库装配为什么是 501（而不是"当作没登录"）────────────────────────────────
 *   返回 `null` 会被守卫读成 `TOKEN_INVALID`（401）—— 于是"没有数据库"伪装成
 *   "你的凭据无效"，用户被引导去反复重新登录，而病在装配。501 才是可执行断言
 *   （与 `NotImplementedDeviceSessionRepository` 同一条）。
 */
export const AUTH_SESSION_REPOSITORY = Symbol('AUTH_SESSION_REPOSITORY')

export interface CreateAuthSessionInput {
  userId: string
  /** **已哈希**（`hashToken()`）；端口不接收明文。 */
  tokenHash: string
  method: AuthMethod
  /** 签发时客户端自报的设备标识：只进审计，不参与判定。 */
  deviceId: string | null
  expiresAt: Date
}

export interface AuthSessionPort {
  /**
   * 按 `tokenHash`（唯一键）查一行。
   *
   * ★ 查不到返回 `null`，**不抛异常** —— 「这个 token 不认识」是正常分支（守卫回 401）。
   * ★ 实现**不得**在 `where` 里加 `revokedAt: null` / `expiresAt > now`：
   *   那样"已撤销"与"已到期"都会变成同一个 401 `TOKEN_INVALID`，
   *   而 §9.3 要求它们分开（`TOKEN_EXPIRED` 可以静默重登，`TOKEN_INVALID` 不行）。
   *   判定一律在 `resolveAuthSession()`。
   */
  findByTokenHash(tokenHash: string): Promise<AuthSessionRow | null>

  /** 签发一行新会话（`issuedAt` / `lastSeenAt` 由库默认值给）。 */
  create(input: CreateAuthSessionInput): Promise<void>

  /** 只更新 `lastSeenAt`；**绝不**动 `expiresAt`（否则就是滑动窗口）。 */
  touch(tokenHash: string, now: Date): Promise<void>

  /** 撤销（`revokedAt=now`）。幂等：已撤销的行再撤销一次 ⇒ `false`，不抛错。 */
  revoke(tokenHash: string, now: Date, reason: string): Promise<boolean>
}

/**
 * **无库装配**时的实现：四个方法**全部显式 501**。
 *
 * ⚠️ 特别说明为什么 `findByTokenHash` **不能**返回 `null`：
 *   那会让守卫回 401 `TOKEN_INVALID` —— 也就是把"这台机器没有数据库"
 *   伪装成"你的凭据无效"。用户会反复重新登录（每次都失败），
 *   而排查方向指向微信凭据 / 客户端存储（都错）。
 */
@Injectable()
export class NotImplementedAuthSessionRepository implements AuthSessionPort {
  private fail(method: string): never {
    throw new NotImplementedException({
      code: 'AUTH_SESSION_NOT_IMPLEMENTED',
      message:
        `当前进程没有 DATABASE_URL（无库装配）⇒ 认证会话不可用：${method} 没有实现。` +
        '有库装配走的是 PrismaAuthSessionRepository（真查/真写 AuthSession）。' +
        '★ 这里**不能**返回"没查到"：那会把装配缺失伪装成 401 TOKEN_INVALID，' +
        '把用户送去反复重新登录，而病在这一行。'
    })
  }

  findByTokenHash(_tokenHash: string): Promise<AuthSessionRow | null> {
    return Promise.resolve(this.fail('findByTokenHash'))
  }

  create(_input: CreateAuthSessionInput): Promise<void> {
    return Promise.resolve(this.fail('create'))
  }

  touch(_tokenHash: string, _now: Date): Promise<void> {
    return Promise.resolve(this.fail('touch'))
  }

  revoke(_tokenHash: string, _now: Date, _reason: string): Promise<boolean> {
    return Promise.resolve(this.fail('revoke'))
  }
}
