import 'dotenv/config'

/**
 * wx-probe.ts —— 微信 `code2session` 的**手工**联通探针（W9-A，2026-10-29 / `40` §13 **S2**）
 *
 * 用法：
 *   npm run wx:probe                      # 只检查凭据是否就位（不打外网）
 *   npm run wx:probe -- --code=<js_code>  # 用真 code 打一次微信
 *
 * ── 为什么它不在 `ci` 里（这是 S2 的退出判据，不是偷懒）─────────────────────
 *   CI 既没有真 AppID/Secret，也没有一个**5 分钟内有效、且只能用一次**的
 *   `js_code`（它由小程序 `wx.login()` 现取）。把"零外网的 CI 必须全绿"和
 *   "真凭据能联通"混成一件事，结果就是两者都不可信。
 *   所以：`test/support/wechat-fake.ts` 覆盖 CI，本脚本覆盖"真凭据"。
 *
 * ── 输出纪律（`40` §11.2）────────────────────────────────────────────────────
 *   只打印 openId 的**掩码**、errcode 与一句结论。
 *   绝不打印 secret / js_code / 完整 openId / session_key —— 一个都不行。
 *   （`js_code` 泄露即可被抢登；`session_key` 能解密用户数据。）
 *
 * ── 退出码（可脚本化）──────────────────────────────────────────────────────
 *   0  凭据就位且（若给了 code）兑换成功
 *   2  缺少 `WECHAT_MP_APPID` / `WECHAT_MP_SECRET`
 *   3  `js_code` 无效/已用过（40029 一类）
 *   4  微信侧限流（45011 一类）—— 退避，**不要**立刻重试
 *   5  **凭据被微信拒绝**（40013/40125）—— ★ 这一条是运维问题，不是用户问题
 *   6  网络/未知错误（超时、非 JSON、未知 errcode）
 */

import {
  HttpWechatCode2Session,
  readWechatConfig
} from '../src/identity/wechat/wechat-code2session.http'

function argValue(name: string): string {
  const prefix = `${name}=`
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return hit === undefined ? '' : hit.slice(prefix.length).trim()
}

/** 只显示前 4 位 + 后 2 位：够用来核对"是不是那个 appid"，不足以当凭据用。 */
function maskAppId(appId: string): string {
  if (appId.length <= 8) return `${appId.slice(0, 2)}***`
  return `${appId.slice(0, 4)}***${appId.slice(-2)}`
}

/** openId 同理：能看出"两次登录是不是同一个人"，但抄下来没用。 */
function maskOpenId(openId: string): string {
  if (openId.length <= 8) return `${openId.slice(0, 2)}***`
  return `${openId.slice(0, 4)}***${openId.slice(-3)}（长度 ${openId.length}）`
}

async function main(): Promise<number> {
  const resolved = readWechatConfig()
  if (resolved.kind === 'MISSING') {
    console.log(
      `✗ 缺少凭据：${resolved.missing.join(' / ')}\n` +
        '  请在 backend/.env 里填（**不要**写进 .env.example / 代码 / 文档）：\n' +
        '    WECHAT_MP_APPID=wx…\n' +
        '    WECHAT_MP_SECRET=…（小程序后台 → 开发管理 → 开发设置）'
    )
    return 2
  }

  const { appId, secret } = resolved.config
  console.log(
    `✓ 凭据已就位：appid=${maskAppId(appId)}，secret=已设置（${secret.length} 字符，不打印）`
  )

  const code = argValue('--code')
  if (code === '') {
    console.log(
      '\n· 没给 --code：只做了凭据检查，**没有**打外网。\n' +
        '  要真打一次，请在小程序里 `wx.login()` 取 code（5 分钟内、只能用一次），然后：\n' +
        '    npm run wx:probe -- --code=<js_code>'
    )
    return 0
  }

  const outcome = await new HttpWechatCode2Session().exchange(code)
  switch (outcome.kind) {
    case 'OK':
      console.log(`✓ code2session 成功：openId=${maskOpenId(outcome.openId)}`)
      console.log('  ⇒ 真凭据可用。接下来 `POST /auth/login` 会用同一个 openId 找到/创建用户。')
      return 0
    case 'CODE_INVALID':
      console.log(
        `✗ js_code 无效（errcode=${outcome.errcode ?? '未知'}）。\n` +
          '  最常见原因：code 已用过 / 超过 5 分钟 / 不是本小程序的 code。\n' +
          '  ⇒ 重新 `wx.login()` 取一个新的 code 再试。'
      )
      return 3
    case 'RATE_LIMITED':
      console.log(
        `✗ 微信侧限流（errcode=${outcome.errcode ?? '未知'}）。\n` +
          '  ⇒ 退避后再试；**不要**在这里循环重试（只会让限流更久）。'
      )
      return 4
    case 'CREDENTIAL_INVALID':
      console.log(
        `✗★ 凭据被微信拒绝（errcode=${outcome.errcode ?? '未知'}）。\n` +
          '  这**不是**用户的问题：AppID 与 AppSecret 不匹配，或 secret 已被重置。\n' +
          '  ⇒ 去小程序后台核对 / 重置 AppSecret，写进 backend/.env 后重启后端。\n' +
          '  （已签发的 AuthSession 不受影响，只影响下一次 code2session。）'
      )
      return 5
    case 'NOT_CONFIGURED':
      console.log(`✗ 缺少凭据：${outcome.missing.join(' / ')}`)
      return 2
    case 'UNAVAILABLE':
      console.log(`✗ 兑换失败：${outcome.detail}\n  ⇒ 网络/微信侧问题，可退避重试。`)
      return 6
  }
}

void main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // ★ 只打消息，不打 process.env / 请求参数（security: 这里最容易顺手 console.log 一大坨）
    console.log(`✗ 探针自己崩了：${error instanceof Error ? error.message : String(error)}`)
    process.exit(6)
  }
)
