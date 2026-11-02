/**
 * app-version.test.ts —— App 自更新版本信息的**纯函数**用例（W10-B，2026-11-02）。
 *
 * ── 这里钉的三件事 ─────────────────────────────────────────────────────────
 *   ① 版本比较必须是**数值逐段**（`1.0.10 > 1.0.9`）；字符串比较会把它判反，
 *      而那个 bug 的表现是\"新版用户永远收不到更新提示\"。
 *   ② 配置错误**不许 500**：版本号 / URL 形状不对一律回退默认值 ——
 *      客户端把\"检查更新失败\"静默掉，等于这次热修彻底失效。
 *   ③ 下载地址只接受 http(s) 绝对地址（`javascript:` 会变成可点击的脚本）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_DOWNLOAD_URL,
  DEFAULT_LATEST_BUILD,
  DEFAULT_LATEST_VERSION,
  compareVersions,
  isDownloadUrl,
  parseVersion,
  resolveAppVersion
} from '../src/app-version/app-version.policy'

describe('版本号解析与比较', () => {
  it('合法 x.y.z 才解析；缺段 / 非数字 / 前后空格都不是合法形状', () => {
    assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3])
    assert.deepEqual(parseVersion(' 1.2.3 '), [1, 2, 3])
    assert.equal(parseVersion('1.2'), null)
    assert.equal(parseVersion('1.2.3.4'), null)
    assert.equal(parseVersion('v1.2.3'), null)
    assert.equal(parseVersion(''), null)
    assert.equal(parseVersion(null), null)
  })

  it('★ 逐段按数值比：1.0.10 > 1.0.9（字符串比较会判反）', () => {
    assert.ok(compareVersions('1.0.10', '1.0.9') > 0)
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
    assert.equal(compareVersions('1.0.1', '1.0.1'), 0)
    assert.ok(compareVersions('0.9.9', '1.0.0') < 0)
  })

  it('非法版本一律排最旧（配置错误不该看起来\"更新\"）', () => {
    assert.ok(compareVersions('oops', '1.0.0') < 0)
    assert.ok(compareVersions('1.0.0', 'oops') > 0)
    assert.equal(compareVersions('oops', 'nope'), 0)
  })
})

describe('下载地址校验', () => {
  it('只接受 http(s) 绝对地址', () => {
    assert.equal(isDownloadUrl('https://hub.littlewish.top:8443/app/a.apk'), true)
    assert.equal(isDownloadUrl('http://82.157.153.22/app/a.apk'), true)
    assert.equal(isDownloadUrl('javascript:alert(1)'), false)
    assert.equal(isDownloadUrl('/app/a.apk'), false)
    assert.equal(isDownloadUrl(''), false)
  })
})

describe('resolveAppVersion：默认值与回退', () => {
  it('空环境 ⇒ 一份形状完整的默认响应', () => {
    const view = resolveAppVersion({})
    assert.equal(view.platform, 'android')
    assert.equal(view.latestVersion, DEFAULT_LATEST_VERSION)
    assert.equal(view.latestBuild, DEFAULT_LATEST_BUILD)
    assert.equal(view.downloadUrl, DEFAULT_DOWNLOAD_URL)
    assert.equal(view.publishedAt, null)
  })

  it('合法环境变量逐项生效', () => {
    const view = resolveAppVersion({
      APP_LATEST_VERSION: '1.2.3',
      APP_LATEST_BUILD: '17',
      APP_MINIMUM_VERSION: '1.2.0',
      APP_MINIMUM_BUILD: '10',
      APP_DOWNLOAD_URL: 'https://example.com/kids.apk',
      APP_RELEASE_NOTES: '修复登录',
      APP_PUBLISHED_AT: '2026-11-02T00:00:00.000Z'
    })
    assert.equal(view.latestVersion, '1.2.3')
    assert.equal(view.latestBuild, 17)
    assert.equal(view.minimumVersion, '1.2.0')
    assert.equal(view.minimumBuild, 10)
    assert.equal(view.downloadUrl, 'https://example.com/kids.apk')
    assert.equal(view.releaseNotes, '修复登录')
    assert.equal(view.publishedAt, '2026-11-02T00:00:00.000Z')
  })

  it('★ 配置错误 ⇒ 回退而不是抛错/500', () => {
    const view = resolveAppVersion({
      APP_LATEST_VERSION: 'latest',
      APP_MINIMUM_VERSION: 'v1',
      APP_LATEST_BUILD: 'abc',
      APP_MINIMUM_BUILD: '-3',
      APP_DOWNLOAD_URL: 'javascript:alert(1)'
    })
    assert.equal(view.latestVersion, DEFAULT_LATEST_VERSION)
    assert.equal(view.minimumVersion, '1.0.0')
    assert.equal(view.latestBuild, DEFAULT_LATEST_BUILD)
    assert.equal(view.minimumBuild, 1)
    assert.equal(view.downloadUrl, DEFAULT_DOWNLOAD_URL)
  })
})
