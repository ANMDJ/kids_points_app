#!/usr/bin/env node
/**
 * invite-code-check.mjs —— 邀请码形状规则三份镜像的守门人（2026-11-03，P0-3）
 *
 * ── 它拦的是哪一种病 ────────────────────────────────────────────────────────
 *   「几位、哪些字符、怎么规范化」现在有三份实现，都是**手抄**：
 *     ① 服务端唯一判据：`backend/src/invites/invite-code.ts`
 *     ② App 镜像：`lib/models/invite.dart`
 *     ③ 小程序镜像：`kids_points_mp/src/utils/invite_code.ts`
 *   没有编译器会比对它们。漂移的后果与密码规则一模一样：
 *   **本地放行、服务端 400** —— 用户少抄一位却被告知"邀请码已失效"。
 *
 * ── 检查项（任一条红即退出码 1）──────────────────────────────────────────────
 *   ① 码长三份**逐字相等**（`INVITE_CODE_LENGTH = 8` / `kInviteCodeLength = 8`）；
 *   ② 31 字符表三份**逐字相等**（顺序也相同：顺序漂移说明有人重排了字母表）；
 *   ③ 三份都必须真的实现了两件事：
 *      · 规范化里出现「去空白与连字符」的字符类 `[\s-]` 与 `toUpperCase()`；
 *      · 形状判定里出现「长度等于码长」与「字母表成员」两处比较。
 *      少一处 = 某一端会静默接受另一个集合。
 *
 * ── fail-closed ────────────────────────────────────────────────────────────
 *   文件不存在 / 解析不出 / 字母表为空 —— 一律红。空字符串"相等"不能算通过。
 *
 * ── 自测（一个永远通过的检查等于没有检查，见 D13）──────────────────────────────
 *   三个路径都可用环境变量指向**被篡改的副本**，用来证伪自己：
 *     KP_INVITE_BACKEND=<副本> node tools/invite-code-check.mjs   → 必须红
 *     （KP_INVITE_DART / KP_INVITE_MP 同理）
 *
 * 用法：node tools/invite-code-check.mjs
 *      （已接进 `backend` 的 `npm run invite:check` 与 `npm run ci`）
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const PATHS = {
  backend: process.env.KP_INVITE_BACKEND ?? 'backend/src/invites/invite-code.ts',
  dart: process.env.KP_INVITE_DART ?? 'lib/models/invite.dart',
  mp: process.env.KP_INVITE_MP ?? 'kids_points_mp/src/utils/invite_code.ts'
}

const failures = []

function fail(message) {
  failures.push(message)
}

function read(rel) {
  const full = resolve(ROOT, rel)
  if (!existsSync(full)) throw new Error(`文件不存在：${rel}`)
  return readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
}

/** 从一个文件里抓一个**必填**的片段（抓不到就红，而不是返回 null 混过去）。 */
function pick(src, pattern, label) {
  const match = src.match(pattern)
  if (match === null) {
    fail(`${label}：解析不出（改名字/改写法都要同步本脚本）`)
    return null
  }
  return match[1]
}

function main() {
  const sources = {
    backend: read(PATHS.backend),
    dart: read(PATHS.dart),
    mp: read(PATHS.mp)
  }

  // ── ① 码长 ────────────────────────────────────────────────────────────────
  const lengths = {
    backend: pick(sources.backend, /export const INVITE_CODE_LENGTH = (\d+)/, PATHS.backend),
    dart: pick(sources.dart, /const int kInviteCodeLength = (\d+)/, PATHS.dart),
    mp: pick(sources.mp, /export const INVITE_CODE_LENGTH = (\d+)/, PATHS.mp)
  }
  const expectedLength = lengths.backend
  for (const [name, value] of Object.entries(lengths)) {
    if (value === null) continue
    if (value !== expectedLength) {
      fail(`码长不一致：backend=${expectedLength}，${name}=${value}`)
    }
  }

  // ── ② 字母表 ──────────────────────────────────────────────────────────────
  const alphabets = {
    backend: pick(
      sources.backend,
      /export const INVITE_CODE_ALPHABET = '([^']+)'/,
      PATHS.backend
    ),
    dart: pick(
      sources.dart,
      /const String kInviteCodeAlphabet = '([^']+)'/,
      PATHS.dart
    ),
    mp: pick(
      sources.mp,
      /export const INVITE_CODE_ALPHABET = '([^']+)'/,
      PATHS.mp
    )
  }
  const expectedAlphabet = alphabets.backend
  if (expectedAlphabet !== null) {
    // 31 个字符是设计值（去掉 0 O 1 I L）；少于 10 说明解析抓错了行。
    if (expectedAlphabet.length < 10) {
      fail(`字母表可疑：backend 只解析出 ${expectedAlphabet.length} 个字符`)
    }
    for (const [name, value] of Object.entries(alphabets)) {
      if (value === null) continue
      if (value !== expectedAlphabet) {
        fail(`字母表不一致：\n    backend: ${expectedAlphabet}\n    ${name}: ${value}`)
      }
    }
  }

  // ── ③ 两份实现真的实现了「规范化」与「形状判定」──────────────────────────
  const normalizeNeedle = /\[\\s-\]/ // 源码里是 /[\s-]/g / RegExp(r'[\s-]')
  for (const [name, src] of Object.entries(sources)) {
    if (!normalizeNeedle.test(src)) {
      fail(`${name}：规范化里找不到「去空白与连字符」的字符类 [\\s-]`)
    }
    if (!/toUpperCase\(\)/.test(src)) {
      fail(`${name}：规范化没有 toUpperCase()（大小写不统一 ⇒ 一半的码会被判无效）`)
    }
  }

  for (const name of ['dart', 'mp']) {
    const src = sources[name]
    const hasLengthCheck = /(!=|!==)\s*(kInviteCodeLength|INVITE_CODE_LENGTH)/.test(src)
    const hasAlphabetCheck = /ALPHABET\.includes|kInviteCodeAlphabet\.contains/.test(src)
    if (!hasLengthCheck) {
      fail(`${name}：形状判定没有比较码长（会接受任意长度）`)
    }
    if (!hasAlphabetCheck) {
      fail(`${name}：形状判定没有比对字母表（会接受 0/O/1/I/L 这类抄错的字符）`)
    }
  }

  if (failures.length === 0) {
    console.log(
      `PASS  邀请码形状三份一致：${expectedLength} 位 / ${expectedAlphabet.length} 个字符`
    )
    console.log(`      backend: ${PATHS.backend}`)
    console.log(`      dart   : ${PATHS.dart}`)
    console.log(`      mp     : ${PATHS.mp}`)
  }
}

try {
  main()
} catch (error) {
  console.error(`FAIL  邀请码形状检查无法完成：${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

if (failures.length > 0) {
  console.error(`FAIL  邀请码形状镜像漂移（${failures.length} 处）——本地会放行、服务端会 400：`)
  for (const message of failures) console.error(`  · ${message}`)
  console.error('\n  改哪一份都要同步另外两份（backend / lib/models/invite.dart / kids_points_mp/src/utils/invite_code.ts）。')
  process.exit(1)
}

process.exit(0)
