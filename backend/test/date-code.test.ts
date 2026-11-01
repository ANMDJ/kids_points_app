/**
 * date-code.test.ts —— 「日期 ＋ 星期」固定规则 6 位验证码（W9-C，2026-10-29）
 *
 * ── 这一步在做什么 ─────────────────────────────────────────────────────────
 *   `POST /auth/date-code` 是**校验**端点：Flutter / 小程序把家长算出来的 6 位码
 *   发上来，服务端用**服务器时钟**按 `MMDD` ＋ 两位 ISO 星期（周一 01 … 周日 07）
 *   重算并比对，回 `{ valid, serverDate, weekDay, dayOffset, acceptedUntil }`。
 *   它**不签发任何凭据**（为什么可以匿名，见 `public.decorator.ts` 的判据）。
 *
 * ── 本文件钉住的六件事 ──────────────────────────────────────────────────────
 *   ① 规则：`1029` ＋ `04` ＝ `102904`（2026-10-29 周四），星期映射周一到周日 01–07；
 *   ② 墙钟：按 **Asia/Shanghai** 的日历日算，不是 UTC 日（跨零点那天最容易错）；
 *   ③ 容差：前后各 1 天接受，且 `dayOffset` 说清命中的是哪一天；
 *   ④ 到期：`acceptedUntil` ＝ 命中日 24:00 ＋ 1 天（窗口 `[day-1, day+1]`）；
 *   ⑤ 接线：不带任何凭据 ⇒ 200（`@Public()` 真被 `Reflector` 读到），
 *      形状错 ⇒ 400、码不对 ⇒ **200 `{ valid:false }`**（不是 401）；
 *   ⑥ 限流：与登录共用 `LoginRateLimiter`，超了 ⇒ 429 `DATE_CODE_RATE_LIMITED`。
 *
 * ── ⚠️ 诚实标注 ─────────────────────────────────────────────────────────────
 *   ① 这个码**不是**认证凭据：`MMDD + 星期` 公开可推导。本文件不测（也不该有）
 *      "用它换取 token" 这件事 —— 那是明确不做的；
 *   ② 限流是**进程内**的（`LoginRateLimiter` 的注释写清了取舍），本文件只证
 *      "单实例内生效"；
 *   ③ 服务器时间用 `new Date()`（没有注入时钟）：跨零点的那一毫秒内
 *      `serverDate` 可能与本文件先算出的值差一天。概率是毫秒级，且容差会接住
 *      那个 6 位码本身，只有 `serverDate` 这**一条**断言可能抖。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import { businessDayOf } from '../src/habits/business-day'
import { AuthGuard } from '../src/identity/auth.guard'
import {
  DATE_CODE_TOLERANCE_DAYS,
  dateVerificationCodeOf,
  isoWeekDayOf,
  verifyDateVerificationCode
} from '../src/identity/date-verification-code'
import { IdentityModule } from '../src/identity/identity.module'

/** 北京时间 10:00（＝02:00Z）—— 这一天是**周四**。 */
const NOW_THU_10AM = new Date('2026-10-29T02:00:00.000Z')

function codeAt(isoInstant: string): string {
  return dateVerificationCodeOf(businessDayOf(new Date(isoInstant)))
}

describe('组 A：规则本身 —— `MMDD` ＋ 两位 ISO 星期', () => {
  it('2026-10-29（周四）⇒ 102904 —— 文档与实现同一算例', () => {
    assert.equal(codeAt('2026-10-29T02:00:00.000Z'), '102904')
  })

  it('★ 星期映射：周一到周日是 01–07（周日写 07，不是 00）', () => {
    // 2026-10-26 是周一；连续七天覆盖整张映射表。
    const expected: Record<string, string> = {
      '2026-10-26T02:00:00.000Z': '102601',
      '2026-10-27T02:00:00.000Z': '102702',
      '2026-10-28T02:00:00.000Z': '102803',
      '2026-10-29T02:00:00.000Z': '102904',
      '2026-10-30T02:00:00.000Z': '103005',
      '2026-10-31T02:00:00.000Z': '103106',
      '2026-11-01T02:00:00.000Z': '110107'
    }
    for (const [instant, code] of Object.entries(expected)) {
      assert.equal(codeAt(instant), code, `${instant} 的码不对`)
    }
  })

  it('★ 墙钟是 Asia/Shanghai：23:59:59 与 00:00:01 分属两天', () => {
    // 2026-10-28T15:59:59Z ＝ 北京 10-28 23:59:59；16:00:01Z ＝ 北京 10-29 00:00:01
    assert.equal(codeAt('2026-10-28T15:59:59.000Z'), '102803')
    assert.equal(codeAt('2026-10-28T16:00:01.000Z'), '102904')
  })

  it('`isoWeekDayOf` 对每个业务日给出 1–7', () => {
    for (let day = 26; day <= 31; day += 1) {
      const weekDay = isoWeekDayOf(businessDayOf(new Date(`2026-10-${day}T02:00:00.000Z`)))
      assert.equal(weekDay, day - 25, `10-${day} 的星期算错了`)
    }
  })
})


describe('组 B：容差（前后各 1 天）与到期时刻', () => {
  it('今天是周四：今天 / 昨天 / 明天的码都通过，`dayOffset` 说清是哪一天', () => {
    const today = verifyDateVerificationCode('102904', NOW_THU_10AM)
    assert.deepEqual(
      { valid: today.valid, dayOffset: today.dayOffset },
      { valid: true, dayOffset: 0 }
    )

    const yesterday = verifyDateVerificationCode('102803', NOW_THU_10AM)
    assert.deepEqual(
      { valid: yesterday.valid, dayOffset: yesterday.dayOffset },
      { valid: true, dayOffset: -1 }
    )

    const tomorrow = verifyDateVerificationCode('103005', NOW_THU_10AM)
    assert.deepEqual(
      { valid: tomorrow.valid, dayOffset: tomorrow.dayOffset },
      { valid: true, dayOffset: 1 }
    )
  })

  it('★ 容差之外一律不通过（前天 / 后天）', () => {
    assert.equal(verifyDateVerificationCode('102702', NOW_THU_10AM).valid, false)
    assert.equal(verifyDateVerificationCode('103106', NOW_THU_10AM).valid, false)
  })

  it('不通过时 `dayOffset` / `acceptedUntil` 都是 null（不留半个结果）', () => {
    const verdict = verifyDateVerificationCode('999999', NOW_THU_10AM)
    assert.equal(verdict.valid, false)
    assert.equal(verdict.dayOffset, null)
    assert.equal(verdict.acceptedUntil, null)
    assert.equal(verdict.serverDate, '2026-10-29')
    assert.equal(verdict.weekDay, 4)
  })

  it('★ 到期时刻 ＝ 命中日 24:00 ＋ 容差天（今天码 ⇒ 10-30T16:00Z）', () => {
    assert.equal(DATE_CODE_TOLERANCE_DAYS, 1)
    assert.equal(
      verifyDateVerificationCode('102904', NOW_THU_10AM).acceptedUntil,
      '2026-10-30T16:00:00.000Z'
    )
    // 昨天的码：窗口截止到「今天 24:00」⇒ 10-29T16:00Z
    assert.equal(
      verifyDateVerificationCode('102803', NOW_THU_10AM).acceptedUntil,
      '2026-10-29T16:00:00.000Z'
    )
  })

  it('形状不对的输入不抛异常、直接判 false（DTO 那层才是 400）', () => {
    for (const bad of ['', '1029', '1029040', 'abcdef', '10290a']) {
      const verdict = verifyDateVerificationCode(bad, NOW_THU_10AM)
      assert.equal(verdict.valid, false, `${JSON.stringify(bad)} 不该通过`)
    }
  })

  it('`now` 非法 ⇒ RangeError（绝不按「大致今天」兜底）', () => {
    assert.throws(() => verifyDateVerificationCode('102904', new Date('nope')), RangeError)
  })
})

// ── 组 C：HTTP 接线 ──────────────────────────────────────────────────────────
interface HttpResult {
  status: number
  body: Record<string, unknown>
  text: string
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed, text }
}

/** 临时改环境变量，跑完必定还原。 */
async function withEnv(
  patch: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}


describe('组 C：`POST /auth/date-code` 的接线（真起 Nest ＋ 真发 HTTP）', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    // `hasDatabase: false` ＋ `wechatConfigured: false`：本端点**不碰库、不碰微信**。
    const moduleRef = await Test.createTestingModule({
      imports: [IdentityModule.register({ hasDatabase: false, wechatConfigured: false })]
    }).compile()

    app = moduleRef.createNestApplication()
    applyGlobalPipes(app) // ★ 与 main.ts 同一函数：DTO 校验测的是真装配
    // ★ 把 `AuthGuard` 挂成全局守卫（与 `AppModule` 的 APP_GUARD 同位）：
    //   否则「匿名可达」这条断言是空的 —— 没有守卫时任何路由都「匿名可达」。
    app.useGlobalGuards(app.get(AuthGuard))
    await app.listen(0, '127.0.0.1')
    url = await app.getUrl()
  })

  after(async () => {
    await app.close()
  })

  it('★ 不带任何凭据 ⇒ 200（`@Public()` 真被 `Reflector` 读到）', async () => {
    // 关掉双读期旁路：否则「没带 token 也放行」是旁路的功劳，测不到 @Public。
    await withEnv({ AUTH_DEVICE_ID_FALLBACK: '0' }, async () => {
      const today = businessDayOf(new Date())
      const r = await post(
        url,
        '/auth/date-code',
        { code: dateVerificationCodeOf(today) },
        { 'x-forwarded-for': '10.9.0.1' }
      )
      assert.equal(r.status, 200, `匿名可达被破坏：${r.text}`)
    })
  })

  it('今天的码 ⇒ valid:true / dayOffset:0，且响应里**没有任何凭据**', async () => {
    const today = businessDayOf(new Date())
    const r = await post(
      url,
      '/auth/date-code',
      { code: dateVerificationCodeOf(today) },
      { 'x-forwarded-for': '10.9.0.2', 'x-kp-device-id': 'dev-date-1' }
    )
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body).sort(), [
      'acceptedUntil',
      'dayOffset',
      'serverDate',
      'valid',
      'weekDay'
    ])
    assert.equal(r.body.valid, true)
    assert.equal(r.body.dayOffset, 0)
    assert.equal(r.body.serverDate, today.day)
    assert.equal(r.body.weekDay, isoWeekDayOf(today))
    assert.match(String(r.body.acceptedUntil), /^\d{4}-\d{2}-\d{2}T/)
  })

  it('码不对 ⇒ **200** `{ valid:false }`（不是 401：它不是认证失败）', async () => {
    const r = await post(
      url,
      '/auth/date-code',
      { code: '000000' },
      { 'x-forwarded-for': '10.9.0.3', 'x-kp-device-id': 'dev-date-2' }
    )
    assert.equal(r.status, 200)
    assert.equal(r.body.valid, false)
    assert.equal(r.body.dayOffset, null)
    assert.equal(r.body.acceptedUntil, null)
  })

  it('少一位 ⇒ 400（形状问题在 DTO 那层，不是「算错了」）', async () => {
    const r = await post(
      url,
      '/auth/date-code',
      { code: '10290' },
      { 'x-forwarded-for': '10.9.0.4' }
    )
    assert.equal(r.status, 400)
    assert.match(r.text, /6 位数字/)
  })

  it('多余键 ⇒ 400（集合封闭，与全仓库同一口径）', async () => {
    const r = await post(
      url,
      '/auth/date-code',
      { code: '102904', userId: 'u-dad' },
      { 'x-forwarded-for': '10.9.0.5' }
    )
    assert.equal(r.status, 400)
  })

  it('★ 连续尝试超限 ⇒ 429 `DATE_CODE_RATE_LIMITED`（与登录共用额度）', async () => {
    const headers = { 'x-forwarded-for': '10.9.0.6', 'x-kp-device-id': 'dev-date-flood' }
    let last: HttpResult | undefined
    for (let i = 0; i < 11; i += 1) {
      last = await post(url, '/auth/date-code', { code: '000000' }, headers)
    }
    assert.equal(last?.status, 429)
    assert.equal(last?.body.code, 'DATE_CODE_RATE_LIMITED')
    assert.equal(last?.body.scope, 'device')
    assert.ok(Number(last?.body.retryAfterSeconds) >= 1)
  })
})

