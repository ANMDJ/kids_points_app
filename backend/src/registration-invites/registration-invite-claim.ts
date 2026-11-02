/**
 * 网站注册邀请码的**占位语句** —— 与「还能不能用」的定义只此一处
 * （W12，2026-11-02 / `docs/design/48-public-invite-acquisition.md` §2）。
 *
 * ── 它为什么必须是一条 SQL ──────────────────────────────────────────────────
 *   用户可能连点两次注册、或两个人同时用同一张码。若「先查有没有用过 →
 *   再写 usedAt」，两个请求会同时看到 `usedAt IS NULL`，双双通过。
 *   条件 `UPDATE … WHERE usedAt IS NULL … RETURNING` 让**至多一个**请求拿到行。
 *
 * ── 为什么标识匹配也在这条 SQL 里 ───────────────────────────────────────────
 *   码绑定 phone + email。若在服务层「先比一次、再占位」，两次读之间
 *   没有任何东西会变（码不可改），但把授权条件写进占位语句可以让
 *   「码可用」与「你能用这张码」成为同一个判断 —— 少一处可能漂移的规则。
 *   ★ 只要求**其中之一**相等：注册页只收一个手机号或邮箱。
 *
 * ── 四种「不能用」仍是同一个回答 ────────────────────────────────────────────
 *   不存在 / 已用过 / 过期 / 已吊销 ⇒ 返回 `null` ⇒ 调用方回 409
 *   `INVITE_CODE_UNAVAILABLE`。区分它们等于给端点一个「哪些码存在」的探测面。
 */
import type { Prisma } from '@prisma/client'

import type { ClaimedRegistrationInviteRow } from './registration-invite.types'

/**
 * 原子占掉一张网站注册邀请码。
 *
 * `identifierValue` 是**已规范化**的手机号或邮箱；与 `phone` / `email`
 * 任一相等即通过。返回值 `null` 表示「这张码不可用」。
 */
export async function claimRegistrationInvite(
  tx: Prisma.TransactionClient,
  input: { code: string; userId: string; identifierValue: string }
): Promise<ClaimedRegistrationInviteRow | null> {
  const claimed = await tx.$queryRaw<ClaimedRegistrationInviteRow[]>`
    UPDATE "RegistrationInvite"
       SET "usedAt" = now(),
           "usedByUserId" = ${input.userId}
     WHERE code = ${input.code}
       AND "usedAt" IS NULL
       AND revoked = false
       AND "expiresAt" > now()
       AND (phone = ${input.identifierValue} OR email = ${input.identifierValue})
    RETURNING id`

  return claimed[0] ?? null
}
