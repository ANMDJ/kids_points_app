/**
 * consent-pii.test.ts —— 同意留痕里的**个人信息最小化**（W7-A，2026-10-26）
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────────
 *   `hashPii()` 有一个**刻意的坏行为**：没有盐时返回 `null`（不存任何东西）。
 *   这类「宁缺勿假」的选择很容易在后续重构里被"优化"成无盐 SHA-256 ——
 *   而那种改动**不会让任何现有用例变红**（摘要照样是 64 位十六进制）。
 *   所以这里把「无盐 ⇒ null」钉成一条独立断言。
 *
 * ── 不测什么 ────────────────────────────────────────────────────────────────
 *   不测 HMAC 算法本身（那是 Node 的职责），只测**我们的选择**：
 *   有盐才算、无盐就空、空值不写入、以及 IP 只取代理链第一跳。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clientIpOf, CONSENT_PII_SALT_ENV, hashPii } from '../src/consent/hash-pii'

const SALTED = { [CONSENT_PII_SALT_ENV]: 'test-salt' } as NodeJS.ProcessEnv
const UNSALTED = {} as NodeJS.ProcessEnv

test('有盐 ⇒ 64 位十六进制 HMAC；同一输入稳定，不同输入不同', () => {
  const a = hashPii('203.0.113.9', SALTED)
  const b = hashPii('203.0.113.9', SALTED)
  const c = hashPii('203.0.113.10', SALTED)

  assert.match(String(a), /^[0-9a-f]{64}$/)
  assert.equal(a, b, '同一来源两次操作必须可比对')
  assert.notEqual(a, c)
})

test('盐不同 ⇒ 摘要不同（盐真的参与了，不是摆设）', () => {
  const one = hashPii('203.0.113.9', { [CONSENT_PII_SALT_ENV]: 'salt-1' } as NodeJS.ProcessEnv)
  const two = hashPii('203.0.113.9', { [CONSENT_PII_SALT_ENV]: 'salt-2' } as NodeJS.ProcessEnv)
  assert.notEqual(one, two)
})

test('★ 没有盐 ⇒ `null`：绝不退回无盐哈希（那样等于留了一份可反推的"证据"）', () => {
  assert.equal(hashPii('203.0.113.9', UNSALTED), null)
  assert.equal(hashPii('Mozilla/5.0', UNSALTED), null)
  // 空白盐按"没配"处理：`CONSENT_PII_SALT=` 是一个很容易出现的配置事故。
  assert.equal(hashPii('203.0.113.9', { [CONSENT_PII_SALT_ENV]: '   ' } as NodeJS.ProcessEnv), null)
})

test('空 / 空白 / 缺失的输入 ⇒ `null`（不把空串哈希成一个"看起来有值"的摘要）', () => {
  assert.equal(hashPii(undefined, SALTED), null)
  assert.equal(hashPii('', SALTED), null)
  assert.equal(hashPii('   ', SALTED), null)
})

test('两端空白先 trim：代理链给的 IP 常带空格，不该因此产生第二个摘要', () => {
  assert.equal(hashPii(' 203.0.113.9 ', SALTED), hashPii('203.0.113.9', SALTED))
})

test('`clientIpOf`：取 `x-forwarded-for` 的**第一跳**（最靠近客户端的那个）', () => {
  assert.equal(clientIpOf({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' }), '203.0.113.9')
  assert.equal(clientIpOf({ 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9')
  assert.equal(clientIpOf({ 'x-forwarded-for': ['198.51.100.7, 10.0.0.1'] }), '198.51.100.7')
})

test('`clientIpOf`：缺失 / 空 / 只有逗号 ⇒ undefined（不编造一个来源）', () => {
  assert.equal(clientIpOf({}), undefined)
  assert.equal(clientIpOf({ 'x-forwarded-for': '' }), undefined)
  assert.equal(clientIpOf({ 'x-forwarded-for': '   ' }), undefined)
  assert.equal(clientIpOf({ 'x-forwarded-for': ' , 10.0.0.1' }), undefined)
})
