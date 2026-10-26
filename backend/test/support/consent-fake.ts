/**
 * 同意闸门的**测试替身**（W7-A，2026-10-26）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *   `ConsentGuard` 是第四道屏障，`@UseGuards(身份, 成员, 矩阵, 同意)` 挂在所有**写**端点上。
 *   离线用例把世界钉死在 `hasDatabase: false` ⇒ 模块里绑的是
 *   `NotImplementedConsentRepository`（501）。若不在用例里注入替身，
 *   **每一条写路径都会停在同意闸门的 501 上** —— 那些用例就会从
 *   「审批端口未落地 ⇒ 501 APPROVALS_PERSISTENCE_NOT_IMPLEMENTED」悄悄变成
 *   「同意端口未落地 ⇒ 501 CONSENT_PERSISTENCE_NOT_IMPLEMENTED」：
 *   状态码一样、code 不一样，断言会红。这不是用例写错了，而是世界少了一块。
 *
 * ── 为什么默认是 `granted` ─────────────────────────────────────────────────
 *   与 `makeMembershipFake()` 同一取舍：这些文件测的是**它们自己的那道关口**
 *   （矩阵 / 业务规则 / 幂等 / 审计），不是同意状态机。想要「撤回后写入停止」的
 *   行为，去 `consent-http.test.ts` 用显式的 `withdrawn` 替身 —— 在那里
 *   403 `CONSENT_REQUIRED` 才是被测对象，而不是背景条件。
 *
 * ── 为什么写入方法直接抛错 ─────────────────────────────────────────────────
 *   `recordGrant` / `recordWithdrawal` 只该由 `ConsentHttpModule` 的 controller 调用。
 *   若某个用例意外走到了这里，抛错比返回一个假状态安全：返回假状态会让
 *   「同意被写入了」看起来成立，而库里其实什么都没有。
 */
import type { ConsentPort, ConsentState } from '../../src/consent/consent.repository'

/** 与 `consent.service.ts` 的默认版本号一致 —— 用例里比对版本时不必再抄一遍。 */
export const TEST_CONSENT_VERSION = '2026-10-draft'

/** 一条「已同意」的状态（`childId` 由调用方给，保持与被测档案一致）。 */
export function grantedConsentState(childId: string): ConsentState {
  return {
    childId,
    status: 'granted',
    consentVersion: TEST_CONSENT_VERSION,
    grantedAt: '2026-10-26T00:00:00.000Z',
    withdrawnAt: null
  }
}

/**
 * 恒返回 `granted` 的端口替身。
 *
 * ★ `readState` 回的是**请求里那个 childId**，不是写死的 `'child-1'`：
 *   写死会让「跨孩子的 id」这类用例（W3-B 的 404 断言）在别的档案上
 *   拿到一个不属于自己的状态 —— 替身比真实现更宽松，用例就测不出东西。
 */
export function makeGrantedConsentFake(): ConsentPort {
  return {
    async readState(childId) {
      return grantedConsentState(childId)
    },
    async recordGrant() {
      throw new Error('用例不应写入同意：这个替身只用于读闸门（写入路径见 consent-http.test.ts）')
    },
    async recordWithdrawal() {
      throw new Error('用例不应写入同意：这个替身只用于读闸门（写入路径见 consent-http.test.ts）')
    }
  }
}
