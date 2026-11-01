/**
 * auth-session-gate.test.ts —— 认证会话判定内核的**离线穷举**（W9-A，2026-10-29）
 *
 * 判据来源：`docs/design/40-login-and-session-design.md` §4.1–§4.5、§5.3、§9.3。
 *
 * ── 这里证明什么（与 HTTP 用例分工）──────────────────────────────────────────
 *   · token 形状 / 哈希 / 到期边界（`expiresAt === now` 即过期）**只**在这里穷举；
 *   · 形状病（非法 method / 时间戳解析不出 / 适配器查错键）必须抛 `AuthSessionShapeError`
 *     —— 它们是 500 的来源，不是 401；
 *   · 两种 401（`TOKEN_INVALID` / `TOKEN_EXPIRED`）**不能合并**：前者重登也修不好，
 *     后者可以静默重登一次修好（§9.3）。
 *
 * ── 这里**不**证明什么（不粉饰）──────────────────────────────────────────────
 *   · Guard 有没有挂上、`kpUser` 有没有被写进请求、500 有没有真的变成 500
 *     ⇒ `test/identity-http.test.ts`（真装配）；
 *   · `tokenHash` 唯一约束与"并发登录只建 1 个 User"⇒ `test-db/auth-session-db.dbtest.ts`（真库）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AUTH_METHODS,
  AUTH_SESSION_TTL_MS,
  AuthSessionShapeError,
  TOKEN_PREFIX,
  authSessionExpiresAt,
  hashToken,
  isWellFormedToken,
  issueToken,
  readBearerToken,
  resolveAuthSession,
  type AuthSessionRow
} from '../src/identity/auth-session.gate'

const NOW = new Date('2026-10-29T12:00:00.000Z')

function row(overrides: Partial<AuthSessionRow> = {}): AuthSessionRow {
  return {
    id: 'as-1',
    userId: 'u-dad',
    tokenHash: hashToken('kps_' + 'a'.repeat(43)),
    method: 'wechat_mp',
    deviceId: 'dev-1',
    issuedAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 1_000),
    expiresAt: new Date(NOW.getTime() + 60_000),
    revokedAt: null,
    ...overrides
  }
}

describe('A 组：凭据形态（issueToken / hashToken）', () => {
  it('前缀 + 43 位 base64url：能被形状校验认出来，也能在日志里一眼看见', () => {
    const token = issueToken()
    assert.equal(isWellFormedToken(token), true, `issueToken 产出了失格的 token：${token.length} 字符`)
    assert.equal(token.startsWith(TOKEN_PREFIX), true)
    assert.equal(token.length, TOKEN_PREFIX.length + 43, '32 字节 base64url 恒为 43 字符')
    assert.equal(/^kps_[A-Za-z0-9_-]{43}$/.test(token), true)
  })

  it('两次签发不重复（256 bit 随机数；重复会直接表现为"两个人共用身份"）', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => issueToken()))
    assert.equal(tokens.size, 200)
  })

  it('库里存的是 sha256 十六进制（64 字符），且同一明文哈希稳定、不同明文哈希不同', () => {
    const a = issueToken()
    const b = issueToken()
    assert.match(hashToken(a), /^[0-9a-f]{64}$/)
    assert.equal(hashToken(a), hashToken(a))
    assert.notEqual(hashToken(a), hashToken(b))
    assert.notEqual(hashToken(a), a, '把明文当哈希落库 = 可反查凭据')
  })

  it('TTL 是 7 天绝对（168 小时），到期时刻 = now + TTL', () => {
    assert.equal(AUTH_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000)

describe('B 组：Authorization 头解析（fail-closed）', () => {
  const token = 'kps_' + 'a'.repeat(43)

  it('缺失 / 空串 ⇒ MISSING（调用方才决定是 401 还是双读期旧路径）', () => {
    assert.deepEqual(readBearerToken(undefined), { kind: 'MISSING' })
    assert.deepEqual(readBearerToken('   '), { kind: 'MISSING' })
  })

  it('Bearer（大小写不敏感）⇒ OK', () => {
    assert.deepEqual(readBearerToken(`Bearer ${token}`), { kind: 'OK', token })
    assert.deepEqual(readBearerToken(`bearer ${token}`), { kind: 'OK', token })
    assert.deepEqual(readBearerToken(`Bearer ${token}  `), { kind: 'OK', token })
  })

  it('重复头 ⇒ MALFORMED（两个凭据并存时不许"随便挑一个"）', () => {
    const result = readBearerToken([`Bearer ${token}`, `Bearer ${token}`])
    assert.equal(result.kind, 'MALFORMED')
  })

  it('其它方案（Basic / Token）⇒ MALFORMED', () => {
    assert.equal(readBearerToken(`Basic ${token}`).kind, 'MALFORMED')
    assert.equal(readBearerToken(token).kind, 'MALFORMED')
  })

  it('形状不对的 token ⇒ MALFORMED（**不查库**：扫描器乱发的字符串不该变成数据库负载）', () => {
    assert.equal(readBearerToken('Bearer kps_short').kind, 'MALFORMED')
    assert.equal(readBearerToken('Bearer abc_' + 'a'.repeat(43)).kind, 'MALFORMED')
    assert.equal(readBearerToken('Bearer ' + 'a'.repeat(43)).kind, 'MALFORMED')
  })
})

describe('C 组：认证判定（resolveAuthSession）', () => {
  it('行不存在 ⇒ TOKEN_INVALID（不是"匿名放行"）', () => {
    assert.deepEqual(resolveAuthSession(null, hashToken('x'), NOW), {
      kind: 'DENY',
      code: 'TOKEN_INVALID'
    })
  })

  it('有效行 ⇒ ALLOW，且带出**行上的** userId（不是客户端说的）', () => {
    const r = row()
    const verdict = resolveAuthSession(r, r.tokenHash, NOW)
    assert.equal(verdict.kind, 'ALLOW')
    if (verdict.kind === 'ALLOW') assert.equal(verdict.row.userId, 'u-dad')
  })

  it('★ 边界：expiresAt === now 即**过期**（与 session.gate 同一口径）', () => {
    const r = row({ expiresAt: new Date(NOW) })
    assert.deepEqual(resolveAuthSession(r, r.tokenHash, NOW), {
      kind: 'DENY',
      code: 'TOKEN_EXPIRED'
    })
  })

  it('边界：now 比 expiresAt 早 1ms ⇒ 仍有效（证明上一条不是恒真）', () => {
    const r = row({ expiresAt: new Date(NOW.getTime() + 1) })
    assert.equal(resolveAuthSession(r, r.tokenHash, NOW).kind, 'ALLOW')
  })

  it('已撤销 ⇒ TOKEN_INVALID（退出登录后客户端必须清 token，不该被"静默重登"救回）', () => {
    const r = row({ revokedAt: new Date(NOW.getTime() - 1000) })
    assert.deepEqual(resolveAuthSession(r, r.tokenHash, NOW), {
      kind: 'DENY',
      code: 'TOKEN_INVALID'
    })
  })

  it('★ lastSeenAt 不参与过期判定（否则就变成滑动窗口：手机丢了凭据无限期活着）', () => {
    const r = row({ lastSeenAt: new Date(NOW.getTime() - 365 * 24 * 3600 * 1000) })
    assert.equal(resolveAuthSession(r, r.tokenHash, NOW).kind, 'ALLOW')
  })

  it('撤销优先于过期（已撤销的行不论到期与否都回答 TOKEN_INVALID）', () => {
    const r = row({
      revokedAt: new Date(NOW.getTime() - 1000),
      expiresAt: new Date(NOW.getTime() - 1)
    })
    assert.deepEqual(resolveAuthSession(r, r.tokenHash, NOW), {
      kind: 'DENY',
      code: 'TOKEN_INVALID'
    })
  })
})


describe('D 组：形状病 ⇒ 500（不是 401，也不是默默当成正常）', () => {
  it('method 不在白名单 ⇒ INVALID_AUTH_METHOD', () => {
    const r = row({ method: 'wechat_app' })
    assert.throws(
      () => resolveAuthSession(r, r.tokenHash, NOW),
      (err: unknown) =>
        err instanceof AuthSessionShapeError && err.code === 'INVALID_AUTH_METHOD'
    )
  })

  it('expiresAt 解析不出 ⇒ INVALID_AUTH_EXPIRY（NaN 比较恒 false，静默失效最难查）', () => {
    const r = row({ expiresAt: 'not-a-date' })
    assert.throws(
      () => resolveAuthSession(r, r.tokenHash, NOW),
      (err: unknown) =>
        err instanceof AuthSessionShapeError && err.code === 'INVALID_AUTH_EXPIRY'
    )
  })

  it('★ 适配器查错键（返回的行不是这个 token 的）⇒ TOKEN_HASH_MISMATCH', () => {
    const r = row()
    assert.throws(
      () => resolveAuthSession(r, hashToken('kps_' + 'b'.repeat(43)), NOW),
      (err: unknown) =>
        err instanceof AuthSessionShapeError && err.code === 'TOKEN_HASH_MISMATCH'
    )
  })

  it('ISO 字符串与 Date 两种形态都能判（线上传输可能是字符串）', () => {
    const r = row({
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      issuedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      lastSeenAt: NOW.toISOString(),
      revokedAt: null
    })
    assert.equal(resolveAuthSession(r, r.tokenHash, NOW).kind, 'ALLOW')
  })
})

    assert.equal(authSessionExpiresAt(NOW).getTime() - NOW.getTime(), AUTH_SESSION_TTL_MS)
  })

  it('方法白名单只有三个值（新增第四个必须同时改这里、`42` §3.4 与 `auth-session.gate.ts` 的说明）', () => {
    // ★ 这条用例的用途是**迫使改动的人停下来想一次**：白名单是"落库之后
    //   守卫还认不认"的唯一开关，多一个值等于多一条签发路径。
    //   W9-D 增加了 `password`（App 手机号/邮箱登录），故从两个值变成三个值。
    assert.deepEqual([...AUTH_METHODS], ['wechat_mp', 'dev_seed', 'password'])
  })
})
