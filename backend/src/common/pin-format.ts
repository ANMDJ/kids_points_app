/**
 * 家长 PIN 的**格式**规则（W8-A 引入，W8-C 提到 `common/`）。
 *
 * ── 为什么从 `onboarding/onboarding.policy.ts` 搬过来 ────────────────────────
 *   `04` §2 第⑥步（引导里设置 PIN）与 `02` §7（切家长模式 / 改 PIN）**必须**用
 *   同一个正则。原先它只住在引导的 policy 里，于是 W8-C 的校验端点要么
 *   `import '../onboarding/onboarding.policy'`（一个鉴权端点反向依赖引导），
 *   要么**抄一份**正则 —— 后者是"两处定义迟早漂移"的经典形态：
 *   引导接受 4–6 位、切模式接受 6 位时，用户会发现"引导里设的 PIN 打不开家长模式"，
 *   而两端各自的用例都是绿的。
 *
 *   搬进 `common/` 后：**一份定义，两个特性共用**。
 *   `onboarding.policy.ts` 原样 re-export 这两个符号，老的 import 路径继续可用
 *   （不为了搬家而改一圈调用点）。
 *
 * ── 为什么是 4–6 位、全串匹配 ───────────────────────────────────────────────
 *   `04` §2 的规格就是 4–6；`^\d{4,6}$` 是**全串**匹配 ——
 *   `PIN_PATTERN.test('x1234')` 必须是 `false`（用 `/\d{4,6}/` 会放过它，
 *   于是"PIN 里混着字母"这种输入会被服务端接受，而客户端键盘根本打不出来）。
 */
export const PIN_PATTERN = /^\d{4,6}$/

/**
 * PIN 明文是否**格式**合法（不判断是否等于已存的 PIN —— 那是 `verifyPin()` 的事）。
 *
 * ★ 格式判定**不计入**「连错 5 次」：那是用户打字失误，不是猜测；
 *   把它计进去会让"手滑输成 3 位"三次就锁住家长（见 `auth/parent-mode.policy.ts`）。
 */
export function isPinFormatValid(pin: string): boolean {
  return PIN_PATTERN.test(pin)
}
