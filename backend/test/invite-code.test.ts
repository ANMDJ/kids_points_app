/**
 * invite-code.test.ts —— 邀请码**纯函数层**的用例（W5-G，2026-10-22）
 *
 * 这一层没有任何 I/O，所以它可以回答一些 HTTP 用例**证明不了**的问题：
 *   ① 字母表真的是 31 个、真的去掉了 `0 O 1 I L`（去掉的理由是"要人口头念"，
 *      而这件事只在**字符集**上成立，不在任何一条 SQL 里）；
 *   ② 生成用的是注入的 picker（默认 `crypto.randomInt`）—— 用例能**确定性地**
 *      造出同一个码，才能证明"撞码会换一个再试"不是碰巧没撞上；
 *   ③ 规范化只做**无歧义**的转换（大小写 / 空格 / 连字符），**不**猜 `O→0`；
 *   ④ `withFreshInviteCode` 的三条出口：成功、非撞码错误立刻上抛、次数用尽响亮失败
 *      （★ 用尽时抛的是**最后一次**的真实错误，不是编一个"重试失败"）。
 *
 * ★ 这里**不**证明唯一约束存在 —— 那是 schema 的事，由真库套件（P2002）证明。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_ATTEMPTS,
  INVITE_CODE_LENGTH,
  INVITE_SESSION_TTL_MS,
  MAX_INVITE_TTL_DAYS,
  MAX_INVITE_USES,
  formatInviteCode,
  generateInviteCode,
  isWellFormedInviteCode,
  normalizeInviteCode,
  withFreshInviteCode
} from '../src/invites/invite-code'

// ══ 组 A：字母表与生成 ═══════════════════════════════════════════════════════
describe('组 A：字母表（31 字符、去掉易认错的 5 个）', () => {
  it('恰好 31 个字符，且无重复', () => {
    assert.equal(INVITE_CODE_ALPHABET.length, 31)
    assert.equal(new Set(INVITE_CODE_ALPHABET).size, 31)
  })

  it('不含 `0 O 1 I L`（口头念 / 手动抄的场合它们会互相认错）', () => {
    for (const char of ['0', 'O', '1', 'I', 'L']) {
      assert.equal(
        INVITE_CODE_ALPHABET.includes(char),
        false,
        `字母表里不该有 ${char}`
      )
    }
  })

  it('全是**大写**字母数字（小写会让"同一个码"变成两个字符串）', () => {
    assert.match(INVITE_CODE_ALPHABET, /^[A-Z2-9]+$/)
  })

  it('生成 8 位，且每一位都在字母表内（200 次抽样）', () => {
    assert.equal(INVITE_CODE_LENGTH, 8)
    for (let i = 0; i < 200; i += 1) {
      const code = generateInviteCode()
      assert.equal(code.length, INVITE_CODE_LENGTH)
      assert.ok(isWellFormedInviteCode(code), `生成的码形状不合法：${code}`)
    }
  })

  it('picker 可注入：`() => 0` ⇒ 全 `A`；`max-1` ⇒ 全 `9`（用例要能确定性地造码）', () => {
    assert.equal(generateInviteCode(() => 0), 'A'.repeat(INVITE_CODE_LENGTH))
    assert.equal(
      generateInviteCode((max) => max - 1),
      INVITE_CODE_ALPHABET[INVITE_CODE_ALPHABET.length - 1].repeat(INVITE_CODE_LENGTH)
    )
  })
})

// ══ 组 B：规范化与形状判定 ═══════════════════════════════════════════════════
describe('组 B：规范化只做无歧义转换', () => {
  it('小写 / 连字符 / 空格 / 制表符 ⇒ 裸大写码', () => {
    assert.equal(normalizeInviteCode('abcd2345'), 'ABCD2345')
    assert.equal(normalizeInviteCode('ABCD-2345'), 'ABCD2345')
    assert.equal(normalizeInviteCode('  abcd 2345 '), 'ABCD2345')
    assert.equal(normalizeInviteCode('ABCD\t2345\n'), 'ABCD2345')
  })

  it('★ 不猜 `O→0` / `l→1`：字母表里没有它们，猜错会把"输错了"变成"看起来对"', () => {
    assert.equal(normalizeInviteCode('ABCD-O234'), 'ABCDO234')
    assert.equal(normalizeInviteCode('abcd-l234'), 'ABCDL234')
  })

  it('形状合法 ⇔ 长度 8 且每位在字母表内', () => {
    assert.equal(isWellFormedInviteCode('ABCD2345'), true)
    // 长度对、字符也在表里（注意 `2` 在表里，`0` 不在）
    assert.equal(isWellFormedInviteCode('ABCD234'), false)
    assert.equal(isWellFormedInviteCode('ABCD23456'), false)
    assert.equal(isWellFormedInviteCode(''), false)
    assert.equal(isWellFormedInviteCode('ABCD2340'), false)
    assert.equal(isWellFormedInviteCode('ABCDO234'), false)
    // ★ 未规范化的输入**不**算合法：判定只认裸码（规范化是调用方的显式一步）。
    assert.equal(isWellFormedInviteCode('abcd2345'), false)
    assert.equal(isWellFormedInviteCode('ABCD-2345'), false)
  })

  it('formatInviteCode 只用于展示：`ABCD2345` ⇒ `ABCD-2345`，且能被规范化回来', () => {
    assert.equal(formatInviteCode('ABCD2345'), 'ABCD-2345')
    assert.equal(normalizeInviteCode(formatInviteCode('ABCD2345')), 'ABCD2345')
    // 长度不对就原样返回（不制造一个"看起来格式化过"的假象）
    assert.equal(formatInviteCode('ABC'), 'ABC')
  })
})

// ══ 组 C：撞码重试的三条出口 ═════════════════════════════════════════════════
describe('组 C：withFreshInviteCode', () => {
  const collision = (): Error => Object.assign(new Error('duplicate code'), { collision: true })
  const isCollision = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { collision?: boolean }).collision === true

  it('第一次就成功 ⇒ 只生成一次', async () => {
    let generated = 0
    const result = await withFreshInviteCode(
      () => `CODE-${(generated += 1)}`,
      async (code) => `ok:${code}`,
      isCollision
    )
    assert.equal(result, 'ok:CODE-1')
    assert.equal(generated, 1)
  })

  it('连撞两次后用第三个码成功（★ 只有唯一约束说了算，不预先查一次）', async () => {
    let generated = 0
    const seen: string[] = []
    const result = await withFreshInviteCode(
      () => `CODE-${(generated += 1)}`,
      async (code) => {
        seen.push(code)
        if (seen.length <= 2) throw collision()
        return `ok:${code}`
      },
      isCollision
    )
    assert.equal(result, 'ok:CODE-3')
    assert.deepEqual(seen, ['CODE-1', 'CODE-2', 'CODE-3'])
  })

  it('非撞码错误立刻上抛，不重试（例如 404 CHILD_NOT_FOUND 不该被吃成重试）', async () => {
    let attempts = 0
    const boom = new Error('child not found')
    await assert.rejects(
      withFreshInviteCode(
        () => 'CODE-X',
        async () => {
          attempts += 1
          throw boom
        },
        isCollision
      ),
      (error: unknown) => error === boom
    )
    assert.equal(attempts, 1)
  })

  it('★ 次数用尽 ⇒ 抛**最后一次真实错误**，且尝试次数有上限', async () => {
    let attempts = 0
    let last: Error | null = null
    await assert.rejects(
      withFreshInviteCode(
        () => `CODE-${(attempts += 1)}`,
        async () => {
          last = collision()
          throw last
        },
        isCollision,
        2
      ),
      (error: unknown) => error === last
    )
    assert.equal(attempts, 2)
    assert.ok(INVITE_CODE_ATTEMPTS >= 1)
  })
})

// ══ 组 D：常量口径 ═══════════════════════════════════════════════════════════
describe('组 D：常量（产品口径，改它要改文档）', () => {
  it('单码最多 10 人、有效期最多 30 天', () => {
    assert.equal(MAX_INVITE_USES, 10)
    assert.equal(MAX_INVITE_TTL_DAYS, 30)
  })

  it('加入后签发的会话 TTL 是 30 天（⚠ 刻意偏离 02 §7 的 5 分钟，见 invite-code.ts）', () => {
    assert.equal(INVITE_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000)
  })
})
