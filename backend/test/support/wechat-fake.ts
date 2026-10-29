import type {
  Code2SessionOutcome,
  WechatCode2SessionPort
} from '../../src/identity/wechat/wechat-code2session.port'

/**
 * 微信 `code2session` 的**内存替身**（W9-A，2026-10-29）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 *   `POST /auth/login` 的第一段是外网调用。测试若真打 `api.weixin.qq.com`：
 *     · 离线/CI 必然红（网络抖动被读成"服务坏了"）；
 *     · 每次跑都要一个**真的** `js_code`（30 秒内有效、一次性）—— 用例无法重放；
 *     · 微信侧限流（`45011`）会让"我们的限流对不对"这条用例变得不可复现。
 *
 * ── 它**故意**只回 `Code2SessionOutcome`，不回 HTTP ──────────────────────────
 *   "哪个结局翻成 401 / 429 / 500 / 502" 是 `IdentityService.openIdOrThrow()`
 *   的职责（端口签名里就没有状态码）。替身若也开始产出状态码，
 *   就会有两套映射 —— 而两套映射的第一天很一致，第三天开始漂移。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   ```ts
 *   const wechat = makeWechatFake()
 *   wechat.enqueue({ kind: 'OK', openId: 'o-dad' })   // 下一次 exchange 的结果
 *   ```
 *   `queue` 空了以后的默认值是 `{ kind: 'OK', openId: 'o-默认' }` —— 让
 *   "只想测别的事"的用例不必每次都 enqueue（默认成功，而不是默认失败：
 *   默认失败会把无关的用例全变成 401，看起来像守卫坏了）。
 */
export interface WechatFake extends WechatCode2SessionPort {
  /** 收到过的 `code`（**只**用于断言"确实把 code 传下去了"；不进日志）。 */
  codes: string[]
  enqueue(outcome: Code2SessionOutcome): void
  reset(): void
}

export const DEFAULT_OPEN_ID = 'o-default-openid'

export function makeWechatFake(): WechatFake {
  const queue: Code2SessionOutcome[] = []
  return {
    codes: [],
    enqueue(outcome) {
      queue.push(outcome)
    },
    reset() {
      queue.length = 0
      this.codes.length = 0
    },
    async exchange(code: string): Promise<Code2SessionOutcome> {
      this.codes.push(code)
      return queue.shift() ?? { kind: 'OK', openId: DEFAULT_OPEN_ID }
    }
  }
}
