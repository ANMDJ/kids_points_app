/**
 * `test-db/` 的真库夹具：**有效监护人同意**（2026-10-27 补）
 *
 * ── 为什么必须有它 ──────────────────────────────────────────────────────────
 *   W7-A 把 `ConsentGuard` 接到了所有写端点上（矩阵里 24 个写动作 ⇒ 缺同意就
 *   403 `CONSENT_REQUIRED`）。真库套件的 `seed()` 只造 `Child` / `User` /
 *   `ChildMember` / `DeviceSession`，**没有** `GuardianConsent` 行 ⇒ 闸门读到
 *   `status: 'none'`，于是 records / rules / habits / approvals* / notifications /
 *   push-e2e 里每个写用例都在第一句 403 上炸掉（`test:db` 266 条里 89 条红）。
 *   这些套件要测的是**各自业务**，不是闸门本身 ⇒ 夹具显式给一次 granted。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────────
 *   · `consentVersion` 用当前文本版本；闸门只判 `status === 'granted'`，
 *     版本号是为了让「撤回 → 重新同意」的用例有可比对的基线。
 *   · 只给**会走写路径**的孩子授权；只读用例与「屏障一必须 403」的角色
 *     （孩子本人、非成员、已删孩子）**刻意不授** —— 那份 403 由权限 / 成员屏障
 *     先给出，不该被同意状态掩盖。
 *   · 想测闸门本身请**不要**用它：`export-db` 就自己写撤回行，来证明
 *     「撤回后导出仍 200、写入 403」这两件事同时成立。
 */
import type { PrismaService } from '../../src/prisma/prisma.service'

/** 与 `src/consent/consent.service.ts` 的默认文本版本保持一致。 */
export const FIXTURE_CONSENT_VERSION = '2026-10-draft'

/**
 * 给若干 `(孩子, 监护人)` 对授予「有效同意」。
 * 必须在 `User` / `Child` 落库之后调用（外键 `grantedBy` 指向 `User`）。
 */
export async function grantConsentFor(
  prisma: PrismaService,
  grants: ReadonlyArray<readonly [childId: string, guardianUserId: string]>
): Promise<void> {
  const grantedAt = new Date()
  await prisma.guardianConsent.createMany({
    data: grants.map(([childId, guardianUserId]) => ({
      childId,
      grantedByUserId: guardianUserId,
      consentVersion: FIXTURE_CONSENT_VERSION,
      status: 'granted',
      grantedAt
    }))
  })
}
