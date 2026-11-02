/**
 * App 版本信息（W10-B，2026-11-02）。
 *
 * ── 它解决的是哪一件事 ──────────────────────────────────────────────────────
 *   在没有应用商店的前提下，装到手机上的包**升级不了**：用户不知道有没有新版，
 *   也没有一个稳定的下载入口。本策略把「最新版本 / 最低版本 / 下载地址 / 更新说明」
 *   收敛成一个**可配置、可测试**的纯函数，HTTP 层（`app-version.controller.ts`）
 *   只负责把它吐出去。
 *
 * ── 为什么放在服务端而不是写死在客户端 ─────────────────────────────────────
 *   写死在客户端 = 每个版本只能知道「自己发布时以为的最新版」。真正的热修
 *   （比如某个版本登录必崩）必须能在**不发新版**的情况下告诉旧客户端「去下载」。
 *
 * ── 为什么是纯函数 ─────────────────────────────────────────────────────────
 *   版本号解析 / 兜底 / URL 校验都是业务判断，值得单测；如果直接写在
 *   controller 里，就只能起一个 Nest 进程去断言字符串，代价和收益不成比例。
 *
 * ── 两个刻意的\"不猜\"（与仓库其它 DTO 同一口径）────────────────────────────
 *   ① 环境变量里的版本号形状不对 ⇒ **回退到默认值并继续服务**，不是 500。
 *      客户端拉版本信息失败会静默不提示更新；如果这里 500，等于把
 *      \"运营填错了一个数字\"变成\"所有客户端更新检查报错\"。
 *   ② 下载地址必须是 http(s) 绝对地址；否则同样回退。一个 `javascript:` 或
 *      相对路径的下载按钮只会让用户困惑。
 */

/** 对外暴露的版本信息（`GET /app/version` 的响应体）。 */
export interface AppVersionView {
  /** 目前只有 android；iOS 走 App Store 时再加。 */
  platform: 'android'
  /** 最新版本（`x.y.z`）。 */
  latestVersion: string
  /** 最新版本的递增构建号；与版本号同版本时用它区分先后。 */
  latestBuild: number
  /** 低于这个版本必须更新（强制更新门槛）。 */
  minimumVersion: string
  /** 低于这个构建号必须更新（与 `minimumVersion` 取\"更严\"的那一个）。 */
  minimumBuild: number
  /** APK 直链（Caddy 静态目录，见 deploy/README §6.2）。 */
  downloadUrl: string
  /** 更新说明（纯文本，客户端原样展示）。 */
  releaseNotes: string
  /** 发布时间（UTC ISO）；没有配置时为 `null`。 */
  publishedAt: string | null
}

/** 默认版本号：与 `pubspec.yaml` 的 `version:` 保持同步（有测试钉住两边）。 */
export const DEFAULT_LATEST_VERSION = '1.0.3'
export const DEFAULT_LATEST_BUILD = 4
export const DEFAULT_MINIMUM_VERSION = '1.0.0'
export const DEFAULT_MINIMUM_BUILD = 1

/**
 * 默认为「本仓库当前构建」的下载地址。
 *
 * ★ 路径与 Caddy 的 `handle_path /app/*` 对齐：站点根 `/var/www/cline-hub/app`，
 *   所以 URL 里带 `/app/` 前缀（见 deploy/README §6.2）。
 */
export const DEFAULT_DOWNLOAD_URL =
  'https://hub.littlewish.top:8443/app/kids-points-app.apk'

export const DEFAULT_RELEASE_NOTES =
  '新增网站「邀请码获取」页（每天限量）；小程序新增邀请码注册页；注册页说明与错误提示同步更新。'

const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

/** `x.y.z` → `[x, y, z]`；形状不对 ⇒ `null`（调用方决定回退还是报错）。 */
export function parseVersion(value: string | undefined | null): number[] | null {
  const trimmed = (value ?? '').trim()
  if (!VERSION_PATTERN.test(trimmed)) return null
  const parts = trimmed.split('.').map((part) => Number.parseInt(part, 10))
  return parts.every((part) => Number.isInteger(part)) ? parts : null
}

/** 语义化版本比较：`a > b` ⇒ 正数，相等 ⇒ 0，`a < b` ⇒ 负数。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  // 非法版本一律排在最旧：它只可能来自配置错误，不该让配置错误\"看起来更新\"。
  if (left === null && right === null) return 0
  if (left === null) return -1
  if (right === null) return 1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 只接受绝对 http(s) 地址（拒绝 `javascript:` / 相对路径 / 空串）。 */
export function isDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key]
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  return trimmed === '' ? fallback : trimmed
}

function readBuild(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * 从环境变量解析出对外的版本信息。
 *
 * 键名：`APP_LATEST_VERSION` / `APP_LATEST_BUILD` / `APP_MINIMUM_VERSION` /
 *       `APP_MINIMUM_BUILD` / `APP_DOWNLOAD_URL` / `APP_RELEASE_NOTES` /
 *       `APP_PUBLISHED_AT`
 *
 * ★ 全部有默认值：没配也能正常回包（客户端至少能拿到一个合法形状）。
 */
export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): AppVersionView {
  const latestVersion = readString(env, 'APP_LATEST_VERSION', DEFAULT_LATEST_VERSION)
  const minimumVersion = readString(env, 'APP_MINIMUM_VERSION', DEFAULT_MINIMUM_VERSION)
  const rawUrl = readString(env, 'APP_DOWNLOAD_URL', DEFAULT_DOWNLOAD_URL)
  const publishedRaw = readString(env, 'APP_PUBLISHED_AT', '')

  return {
    platform: 'android',
    latestVersion: parseVersion(latestVersion) === null ? DEFAULT_LATEST_VERSION : latestVersion,
    latestBuild: readBuild(env, 'APP_LATEST_BUILD', DEFAULT_LATEST_BUILD),
    minimumVersion:
      parseVersion(minimumVersion) === null ? DEFAULT_MINIMUM_VERSION : minimumVersion,
    minimumBuild: readBuild(env, 'APP_MINIMUM_BUILD', DEFAULT_MINIMUM_BUILD),
    downloadUrl: isDownloadUrl(rawUrl) ? rawUrl : DEFAULT_DOWNLOAD_URL,
    releaseNotes: readString(env, 'APP_RELEASE_NOTES', DEFAULT_RELEASE_NOTES),
    // ★ 不校验日期形状：它只是一个展示字段，填错不该让整条接口回退。
    //   非空即原样返回；客户端解析失败时自行忽略。
    publishedAt: publishedRaw === '' ? null : publishedRaw
  }
}
