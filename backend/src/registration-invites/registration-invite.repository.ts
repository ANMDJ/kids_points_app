import { Injectable, NotImplementedException } from '@nestjs/common'

import type {
  CreateRegistrationInviteInput,
  CreateRegistrationInviteResult,
  RegistrationInviteLookup,
  RegistrationInviteQuotaSnapshot
} from './registration-invite.types'

/**
 * 网站注册邀请码的**持久化端口**（W12，2026-11-02）。
 *
 * ── 为什么两个方法不在一个「大端口」里 ──────────────────────────────────────
 *   `createInvite` 只被网站发放端点用；`findByCode` 只被注册端点用（用来
 *   **路由**：这张码是网站发的，还是家庭邀请码）。两者共享同一张表，但
 *   使用方完全不相交 —— 放在一个端口里仍然是一个端口，只是读起来更清楚。
 *
 * ── 无库装配 ⇒ 501，绝不「假装发了一张码」──────────────────────────────────
 *   回一张看起来正常的码，而库里没有它 ⇒ 用户去注册永远 409，
 *   客服会从「注册」查到「发码」，而病是装配。
 */
export const REGISTRATION_INVITE_REPOSITORY = Symbol('REGISTRATION_INVITE_REPOSITORY')

export interface RegistrationInvitePort {
  /**
   * 原子地「占一个当日额度 + 落一张码」。
   *
   * `kind: 'quota_exhausted'` 是正常结局；`code` 撞唯一约束时由适配器
   * 换码重试（`withFreshInviteCode`），调用方看不到撞码。
   */
  createInvite(input: CreateRegistrationInviteInput): Promise<CreateRegistrationInviteResult>

  /**
   * 按裸码查一行（含已用过 / 已吊销的行）。
   *
   * ★ 它只用于**路由**，不用于授权：真正的「能不能用」由
   *   `claimRegistrationInvite()` 的一条 SQL 回答。返回非 null 意味着
   *   「这是网站发的码」，即使它已经失效 —— 那种情况必须回 409，
   *   而不是掉回家庭邀请码路径再回 409（同一个回答，但路径不对）。
   */
  findByCode(code: string): Promise<RegistrationInviteLookup | null>

  /**
   * 只读当日额度（页面在提交前显示「今日还剩 N 个」）。
   *
   * ★ 它**不**参与授权：真正的额度判定在 `createInvite` 的原子 UPDATE 里。
   *   页面拿到的「还剩 1 个」随时可能被别人用掉 —— 所以它只能用来提示，
   *   不能用来预测「我一定能拿到」。
   */
  readQuota(input: { day: string; dailyLimit: number }): Promise<RegistrationInviteQuotaSnapshot>
}

@Injectable()
export class NotImplementedRegistrationInviteRepository implements RegistrationInvitePort {
  async createInvite(_input: CreateRegistrationInviteInput): Promise<CreateRegistrationInviteResult> {
    throw new NotImplementedException({
      code: 'REGISTRATION_INVITE_NOT_IMPLEMENTED',
      message:
        '当前进程没有 DATABASE_URL（无库装配）⇒ 网站邀请码不可用：createInvite 没有实现。' +
        '★ 拒绝而不是假装发码：发一张库里不存在的码，用户注册时只会得到 409。'
    })
  }

  async findByCode(_code: string): Promise<RegistrationInviteLookup | null> {
    // ★ 这里是「无库 ⇒ 501」原则的**唯一例外**，理由是它不回答「能不能用」：
    //   它只回答「这张码是不是网站发的」。没有库时永远无法判断来源，而
    //   注册写入本来就会在下一步撞上 `NotImplementedInviteRegistrationRepository`
    //   的 501 —— 用户仍然拿不到任何凭据。若这里也抛 501，会把「注册不可用」
    //   伪装成「网站发码不可用」，排查方向直接跑偏。
    return null
  }

  async readQuota(_input: {
    day: string
    dailyLimit: number
  }): Promise<RegistrationInviteQuotaSnapshot> {
    throw new NotImplementedException({
      code: 'REGISTRATION_INVITE_NOT_IMPLEMENTED',
      message:
        '当前进程没有 DATABASE_URL（无库装配）⇒ 无法读取当日额度：readQuota 没有实现。' +
        '★ 拒绝而不是回 0：那会让页面显示「今天还有 0 个」，与「没有库」混为一谈。'
    })
  }
}
