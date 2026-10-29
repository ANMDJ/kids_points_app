import { Injectable, NotImplementedException } from '@nestjs/common'

import type { AuthMethod } from './auth-session.gate'

/**
 * 登录 / 建孩子 / 补设备会话的**持久化端口**（W9-A，2026-10-29 / `40` §6–§8）。
 *
 * ── 为什么它与 `AuthSessionPort` 分开 ────────────────────────────────────────
 *   · `AuthSessionPort` 是**每个请求**都要走的读路径（守卫），一行一个索引查询；
 *   · 本端口是**偶尔发生**的写路径（登录 / 建孩子 / 补会话），每个方法一个事务。
 *   合成一个端口会让守卫拿到一堆永远不会调用的写方法（接口面变宽 ⇒ 替身越来越难写，
 *   而替身越难写，用例就越容易只测"能编译"）。
 *
 * ── `loginWithOpenId` 为什么必须是一个原子操作 ───────────────────────────────
 *   `User.openId` 有 `@unique` 约束。若"先 `findUnique` 再 `create`"，
 *   同一家长在两台设备上同时首次登录（**正常动作**，不是攻击）会双双读到 `null`，
 *   第二个 `INSERT` 撞唯一键 ⇒ 500。Prisma 会把 `upsert` 编译成单条
 *   `INSERT … ON CONFLICT`，但那是**实现细节** ⇒ 真库并发用例钉着
 *   （`test-db/auth-session-db.dbtest.ts`）。
 *
 * ── 三个"不在这里判"（刻意的）──────────────────────────────────────────────
 *   ① 不验 token 形状 / 到期：那是 `auth-session.gate.ts`（纯函数）；
 *   ② 不把 WeChat 错误翻成 HTTP：那是 service；
 *   ③ 不判断"这个人该不该有家长权限"：那是 `MembershipGuard` 与矩阵。
 *      本端口只如实回答"库里现在是什么"。
 */
export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY')

/** 登录时要写的两件事（`User` upsert ＋ `AuthSession` 一行），同一事务。 */
export interface LoginWithOpenIdInput {
  openId: string
  /** **已哈希**的 token（端口不接收明文）。 */
  tokenHash: string
  method: AuthMethod
  deviceId: string | null
  expiresAt: Date
}

export interface LoginUserRow {
  userId: string
  displayName: string | null
}

/** `GET /auth/session` 的 `children[]` 一项（角色取**成员位**，不取会话的 activeRole）。 */
export interface ChildMembershipRow {
  childId: string
  name: string
  /** 原始 `MemberRole` 字符串（guardian | child | viewer）—— 白名单校验在 service。 */
  role: string
}

export interface BootstrapChildInput {
  /** 来自 Bearer token（**绝不**取请求体）。 */
  userId: string
  /** 服务端给出的协议版本（客户端的任何版本号都会被忽略）。 */
  consentVersion: string
  ipHash: string | null
  userAgentHash: string | null
  /** `father` / `mother` / `grandparent` / `other`（缺省 `other`）。 */
  relation: string
  /** 这台设备在该孩子上的**引导期**会话窗口（`now + PARENT_MODE_TTL_MS`）。 */
  parentModeUntil: Date
  /** 客户端自报的设备标识 —— `DeviceSession` 的行键（不是凭据）。 */
  deviceId: string
}

export interface BootstrapChildResult {
  childId: string
  role: 'guardian'
  parentModeUntil: Date
}

export interface EnsureChildSessionInput {
  userId: string
  childId: string
  deviceId: string
  /** `now + INVITE_SESSION_TTL_MS`（设备登录口径 30 天，与邀请码同一个常数）。 */
  sessionExpiresAt: Date
}

export interface EnsureChildSessionResult {
  /** 成员位上的角色（**不是**请求体说的）。 */
  role: string
  sessionExpiresAt: Date
}

export interface IdentityPort {
  /** 原子 upsert `User.openId` ⇒ 写一条 `AuthSession`。返回用户的**最小**信息。 */
  loginWithOpenId(input: LoginWithOpenIdInput): Promise<LoginUserRow>

  /**
   * 读当前用户的展示信息（`GET /auth/session` 用）。
   *
   * ★ 只返回 `status='active'` 的用户；停用/已注销返回 `null`
   *   （service 翻 403 `USER_NOT_ACTIVE` —— 不发凭据的人，也不该被当成"登录成功"）。
   */
  readUser(userId: string): Promise<LoginUserRow | null>

  /** 这个人是哪些孩子的**有效**成员（`ChildMember.status='active'`）。 */
  listChildren(userId: string): Promise<ChildMembershipRow[]>

  /**
   * 从零建第一个孩子 —— **7 步同一事务**（`40` §7.4）。
   *
   * 已有 `status='active'` 的成员位 ⇒ 抛 409 `CHILD_LIMIT_REACHED`（首版一人一家庭）。
   * ★ 抛错即整体回滚 ⇒ **不会**留下"同意了但没建孩子"或"建了孩子但没有同意"。
   */
  bootstrapChild(input: BootstrapChildInput): Promise<BootstrapChildResult>

  /**
   * 已登录用户在**这台设备**上补一行 `DeviceSession`（`(deviceId, childId)` 唯一键）。
   *
   * 没有成员位 ⇒ 403 `NOT_A_MEMBER`；行已属于**别人** ⇒ 409 `DEVICE_SESSION_CONFLICT`
   * （共享平板是真实现场，与邀请码同一条文案口径）。
   */
  ensureChildSession(input: EnsureChildSessionInput): Promise<EnsureChildSessionResult>
}

/**
 * **无库装配**：四个方法全部 501。
 *
 * ⚠️ `loginWithOpenId` 尤其不能"假装成功"：回一个 token 出去，会让客户端
 *   以为登录完成了，而下一次请求（守卫查 `AuthSession`）必然 401 ——
 *   用户会在"登录成功"与"请重新登录"之间无限循环，而病是装配。
 */
@Injectable()
export class NotImplementedIdentityRepository implements IdentityPort {
  private fail(method: string): never {
    throw new NotImplementedException({
      code: 'IDENTITY_NOT_IMPLEMENTED',
      message:
        `当前进程没有 DATABASE_URL（无库装配）⇒ 登录链路不可用：${method} 没有实现。` +
        '有库装配走的是 PrismaIdentityRepository（真写 User / AuthSession / Child / ChildMember …）。' +
        '★ 拒绝而不是假装成功：回一个 token 出去会让客户端以为已登录，而下一次请求必然 401。'
    })
  }

  loginWithOpenId(_input: LoginWithOpenIdInput): Promise<LoginUserRow> {
    return Promise.resolve(this.fail('loginWithOpenId'))
  }

  readUser(_userId: string): Promise<LoginUserRow | null> {
    return Promise.resolve(this.fail('readUser'))
  }

  listChildren(_userId: string): Promise<ChildMembershipRow[]> {
    return Promise.resolve(this.fail('listChildren'))
  }

  bootstrapChild(_input: BootstrapChildInput): Promise<BootstrapChildResult> {
    return Promise.resolve(this.fail('bootstrapChild'))
  }

  ensureChildSession(_input: EnsureChildSessionInput): Promise<EnsureChildSessionResult> {
    return Promise.resolve(this.fail('ensureChildSession'))
  }
}
