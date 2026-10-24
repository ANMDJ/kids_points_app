import { Injectable, NotImplementedException } from '@nestjs/common'

import type {
  ActivePushToken,
  RegisterDeviceTokenInput,
  RegisterDeviceTokenResult,
  RevokeDeviceTokenResult
} from './device-tokens.types'

/**
 * 设备推送 token 的**持久化端口**（W6-A，2026-10-24）。
 *
 * ── 四个方法，各有唯一的调用方 ──────────────────────────────────────────────
 *   · `register` / `revoke` —— HTTP 层（`DeviceTokensService`）；
 *   · `listActiveForUser` / `deactivateTokens` —— 推送适配器（`WebhookPushAdapter`）。
 *   刻意**没有** `findByToken()`：一旦对外暴露「只查不判」，下一个人就会写成
 *   「先查这个 token 是不是我的 → 再写」—— 那正是 TOCTOU 的形状。
 *   归属判定必须在**写入的那条语句 / 那个事务里**回答（见 Prisma 适配器）。
 *
 * ── 为什么 `deactivateTokens` 在端口上 ──────────────────────────────────────
 *   网关回答 410（或列出 `invalidTokens`）时，**只有持库的人**能把它们标成失效。
 *   让适配器自己 new 一个 PrismaClient 会绕过全局连接池与事务边界
 *   （`01` §4 的同一条纪律）。
 */
export const DEVICE_TOKENS_REPOSITORY = Symbol('DEVICE_TOKENS_REPOSITORY')

export interface DeviceTokensPort {
  register(input: RegisterDeviceTokenInput): Promise<RegisterDeviceTokenResult>
  revoke(input: { userId: string; token: string }): Promise<RevokeDeviceTokenResult>
  /** 按 `userId` 取所有可推送的 token（含上限淘汰后的结果，见 types 文件头 ③）。 */
  listActiveForUser(userId: string): Promise<ActivePushToken[]>
  /** 网关判定失效后调用；返回真正被改动的行数（幂等：已失效的不会再算一次）。 */
  deactivateTokens(tokens: string[]): Promise<number>
}

/**
 * 无库装配：**每一个**方法都 501。
 *
 * ── 为什么不做成「空列表 / 假装成功」────────────────────────────────────────
 *   `listActiveForUser` 回 `[]` 会让推送适配器回答 `no_device_token` ——
 *   那是「这个人没有设备」的结论，与「根本没接库」完全是两件事。
 *   注册回 200 更糟：客户端会以为 token 已落库，直到某天推送永远不到。
 *   501 让「没有库」成为一个**当场可断言**的事实（与 `NotImplementedMembersRepository` 同一口径）。
 */
@Injectable()
export class NotImplementedDeviceTokensRepository implements DeviceTokensPort {
  async register(_input: RegisterDeviceTokenInput): Promise<RegisterDeviceTokenResult> {
    throw this.notImplemented('登记设备推送 token')
  }

  async revoke(_input: { userId: string; token: string }): Promise<RevokeDeviceTokenResult> {
    throw this.notImplemented('注销设备推送 token')
  }

  async listActiveForUser(_userId: string): Promise<ActivePushToken[]> {
    throw this.notImplemented('读取可推送的设备 token')
  }

  async deactivateTokens(_tokens: string[]): Promise<number> {
    throw this.notImplemented('把失效的设备 token 置为 inactive')
  }

  private notImplemented(what: string): NotImplementedException {
    return new NotImplementedException({
      code: 'DEVICE_TOKENS_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `当前装配没有数据库连接：${what}无处落库，拒绝假装成功。` +
        '请配置 DATABASE_URL 后重试。'
    })
  }
}
