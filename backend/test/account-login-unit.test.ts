/**
 * account-login-unit.test.ts —— App 账号登录的**纯函数**用例（W9-D，2026-10-30）
 *
 * ── 这里钉的是什么 ─────────────────────────────────────────────────────────
 *   两件事最容易"看起来对、其实错"，而且都不需要数据库就能穷举：
 *     ① **规范化只有一处**：同一个手机号写成四种样子必须落到同一个值 ——
 *        否则 `User.phone` 的唯一索引形同虚设（同一个人绑出三行账号）；
 *     ② **密码哈希与 PIN 哈希不可互换**：前缀不同 ⇒ 把 4 位 PIN 的哈希抄进
 *        `User.passwordHash` 之后，`verifyPassword('0000')` 必须**仍然 false**。
 *        一条用例钉住这条越权路径。
 *
 * ⚠️ 诚实标注：本文件**不**证明"密码不可暴力破解"（那是 N=16384 的数学性质 +
 *   限流共同给的），也不证明 HTTP 层的错误码 —— 后者在
 *   `test/account-login-http.test.ts`。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  classifyIdentifier,
  normalizeEmail,
  normalizePhone,
  validatePasswordStrength
} from '../src/identity/account-identifier'
import {
  burnPasswordHashCost,
  hashPassword,
  PASSWORD_HASH_PREFIX,
  passwordAuditValue,
  verifyPassword
} from '../src/common/password-hash'
import { hashPin } from '../src/common/pin-hash'

describe('账号标识：手机号规范化', () => {
  it('★ 四种写法必须落到同一个值（唯一索引的前提）', () => {
    const expected = { kind: 'ok', identifier: { type: 'phone', value: '13800138000' } }
    for (const raw of [
      '13800138000',
      '138 0013 8000',
      '138-0013-8000',
      '+86 138 0013 8000',
      '+8613800138000',
      '8613800138000',
      ' (138) 0013-8000 '
    ]) {
      assert.deepStrictEqual(normalizePhone(raw), expected, `输入：${JSON.stringify(raw)}`)
    }
  })

  it('不剥 11 位号码里的前缀（`13800138000` 不能被误剥成 9 位）', () => {
    assert.deepStrictEqual(normalizePhone('13800138000'), {
      kind: 'ok',
      identifier: { type: 'phone', value: '13800138000' }
    })
  })

  it('非法号段 / 位数 / 空串各自有不同原因', () => {
    assert.deepStrictEqual(normalizePhone('12800138000'), {
      kind: 'invalid',
      reason: 'PHONE_FORMAT'
    })
    assert.deepStrictEqual(normalizePhone('1380013800'), {
      kind: 'invalid',
      reason: 'PHONE_FORMAT'
    })
    assert.deepStrictEqual(normalizePhone('1380013800012345'), {
      kind: 'invalid',
      reason: 'TOO_LONG'
    })
    assert.deepStrictEqual(normalizePhone('   '), { kind: 'invalid', reason: 'EMPTY' })
    assert.deepStrictEqual(normalizePhone('+1 415 555 0100'), {
      kind: 'invalid',
      reason: 'PHONE_FORMAT'
    })
  })
})

describe('账号标识：邮箱规范化', () => {
  it('统一小写 + trim（大小写不敏感是现实口径）', () => {
    assert.deepStrictEqual(normalizeEmail('  Dad@Example.COM '), {
      kind: 'ok',
      identifier: { type: 'email', value: 'dad@example.com' }
    })
  })

  it('★ 不做 provider 特定的点号/加号归一（那会把两个人合成一个账号）', () => {
    const dotted = normalizeEmail('a.b@gmail.com')
    const plain = normalizeEmail('ab@gmail.com')
    assert.notDeepStrictEqual(dotted, plain)
  })

  it('结构错一律 EMAIL_FORMAT，不给「手机号错」的文案', () => {
    for (const raw of [
      'dad@',
      '@example.com',
      'dad@@example.com',
      'dad@example',
      'dad..x@example.com',
      '.dad@example.com',
      'dad@.example.com',
      'dad@exa mple.com'
    ]) {
      assert.deepStrictEqual(normalizeEmail(raw), { kind: 'invalid', reason: 'EMAIL_FORMAT' }, raw)
    }
  })

  it('超长邮箱判 TOO_LONG', () => {
    const long = `${'a'.repeat(250)}@e.com`
    assert.deepStrictEqual(normalizeEmail(long), { kind: 'invalid', reason: 'TOO_LONG' })
  })
})

describe('账号标识：分类', () => {
  it('含 @ 走邮箱，否则走手机号', () => {
    assert.deepStrictEqual(classifyIdentifier('Dad@Example.com'), {
      kind: 'ok',
      identifier: { type: 'email', value: 'dad@example.com' }
    })
    assert.deepStrictEqual(classifyIdentifier('13800138000'), {
      kind: 'ok',
      identifier: { type: 'phone', value: '13800138000' }
    })
  })

  it('空串 / 纯空白 ⇒ EMPTY（登录与绑定共用这一支）', () => {
    assert.deepStrictEqual(classifyIdentifier(''), { kind: 'invalid', reason: 'EMPTY' })
    assert.deepStrictEqual(classifyIdentifier('   '), { kind: 'invalid', reason: 'EMPTY' })
  })
})

describe('密码强度', () => {
  it('正常密码通过', () => {
    assert.deepStrictEqual(validatePasswordStrength('jiazhang2026'), { kind: 'ok' })
  })

  it('太短 / 太长分别有各自的原因', () => {
    assert.deepStrictEqual(validatePasswordStrength('abc1234'), {
      kind: 'invalid',
      reason: 'TOO_SHORT'
    })
    assert.deepStrictEqual(validatePasswordStrength('a'.repeat(65)), {
      kind: 'invalid',
      reason: 'TOO_LONG'
    })
  })

  it('★ 单一字符 / 纯数字 / 常见弱口令都被拦（三句不同的话）', () => {
    assert.deepStrictEqual(validatePasswordStrength('aaaaaaaa'), {
      kind: 'invalid',
      reason: 'ALL_SAME'
    })
    assert.deepStrictEqual(validatePasswordStrength('20261030'), {
      kind: 'invalid',
      reason: 'ALL_DIGITS'
    })
    assert.deepStrictEqual(validatePasswordStrength('Password'), {
      kind: 'invalid',
      reason: 'COMMON'
    })
    assert.deepStrictEqual(validatePasswordStrength('qwerty123'), {
      kind: 'invalid',
      reason: 'COMMON'
    })
  })

  it('★ 密码与自己的标识相同 ⇒ SAME_AS_IDENTIFIER（含邮箱本地部分）', () => {
    assert.deepStrictEqual(validatePasswordStrength('13800138000', '13800138000'), {
      kind: 'invalid',
      reason: 'SAME_AS_IDENTIFIER'
    })
    assert.deepStrictEqual(validatePasswordStrength('dad@example.com', 'dad@example.com'), {
      kind: 'invalid',
      reason: 'SAME_AS_IDENTIFIER'
    })
    // 本地部分本身够长时才走到这一支；`dad`（3 字符）会先被 TOO_SHORT 拦下 —— 那是对的。
    assert.deepStrictEqual(validatePasswordStrength('zhanglaoshi', 'zhanglaoshi@example.com'), {
      kind: 'invalid',
      reason: 'SAME_AS_IDENTIFIER'
    })
    assert.deepStrictEqual(validatePasswordStrength('dad', 'dad@example.com'), {
      kind: 'invalid',
      reason: 'TOO_SHORT'
    })
  })

  it('大小写不同不算"与标识相同"（但弱口令表本身是小写的）', () => {
    assert.deepStrictEqual(validatePasswordStrength('DadLoves2026', 'dad@example.com'), {
      kind: 'ok'
    })
  })
})

describe('密码哈希', () => {
  it('同一明文两次哈希不同（每次独立盐），但都能验证通过', async () => {
    const a = await hashPassword('jiazhang2026')
    const b = await hashPassword('jiazhang2026')
    assert.notStrictEqual(a, b)
    assert.strictEqual(await verifyPassword('jiazhang2026', a), true)
    assert.strictEqual(await verifyPassword('jiazhang2026', b), true)
  })

  it('自描述格式：前缀 + 五个参数位（将来调参数时旧哈希仍可验）', async () => {
    const stored = await hashPassword('jiazhang2026')
    const parts = stored.split('$')
    assert.strictEqual(parts.length, 7)
    assert.strictEqual(parts[0], PASSWORD_HASH_PREFIX)
    assert.strictEqual(parts[4], '32')
  })

  it('密码不对 / 没有密码 / 格式损坏 ⇒ 一律 false（不抛错）', async () => {
    const stored = await hashPassword('jiazhang2026')
    assert.strictEqual(await verifyPassword('jiazhang2027', stored), false)
    assert.strictEqual(await verifyPassword('jiazhang2026', null), false)
    assert.strictEqual(await verifyPassword('jiazhang2026', ''), false)
    assert.strictEqual(await verifyPassword('jiazhang2026', 'scrypt$1$2$3'), false)
    assert.strictEqual(await verifyPassword('jiazhang2026', `${stored}$extra`), false)
  })

  it('★ PIN 哈希不能当密码哈希用（前缀不同 ⇒ 直接 false）', async () => {
    const pinHash = await hashPin('0000')
    assert.strictEqual(await verifyPassword('0000', pinHash), false)
  })

  it('空跑一次不抛错（时序对齐用的，不参与判定）', async () => {
    await burnPasswordHashCost()
  })

  it('审计值只回答"设置了没有"，不泄漏长度', () => {
    assert.strictEqual(passwordAuditValue(null), false)
    assert.strictEqual(passwordAuditValue('scrypt-pw$1$2$3$4$5$6'), true)
  })
})

