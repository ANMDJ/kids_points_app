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

  /**
   * 撤销该用户**除 `keepTokenHash` 之外**的全部未撤销会话，返回撤销条数（W9-D）。
   *
   * ── 为什么改密码必须调它（这是密码方案唯一的安全兜底）───────────────────────
   *   密码泄露的典型后果是"别人已经拿到了一条 token"。改密码若只换哈希，
   *   那条 token 仍然有效到 `expiresAt`（最长 7 天）—— 用户会以为"我改过了，
   *   应该没事了"，而攻击者还在里面。⇒ 改密 = 换哈希 **＋** 踢掉其它会话。
   *
   * `keepTokenHash` 保留**当前这一条**：否则用户改完密码会被自己踢下线，
   * 体验上像"改密码把账号弄坏了"，而且下一次请求 401 会让他以为改失败了。
   *
   * `null` ⇒ 撤销全部（将来"退出所有设备"用它）。
   */
  revokeOthers(
    userId: string,
    keepTokenHash: string | null,
    now: Date,
    reason: string
  ): Promise<number>
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

  revokeOthers(
    _userId: string,
    _keepTokenHash: string | null,
    _now: Date,
    _reason: string
  ): Promise<number> {
    return Promise.resolve(this.fail('revokeOthers'))
  }
}
