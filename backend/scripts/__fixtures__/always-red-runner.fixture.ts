/**
 * always-red-runner.fixture.ts —— **故意失败**的夹具（不属于任何自动发现范围）
 *
 * 只许被 `scripts/test-can-fail.mjs` 以**显式路径**调用。
 * 文件名刻意**不叫** `*.test.ts`，且所在路径里没有名为 `test` 的目录段 ——
 * 因此 Node 的测试发现规则永远不会自动跑到它（它一旦被自动跑到，CI 就会永久变红）。
 *
 * 存在理由：D12 的教训 —— 「测试通过」这个信号**自身**必须被测试过。
 * 若这个夹具跑出来是绿的，说明 runner 不能失败 ⇒ 整套测试都不可信。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('夹具・必红①：断言不相等', () => {
  assert.equal(1, 2, '夹具刻意失败：本行必须让退出码非 0')
})

test('夹具・必红②：assert.fail', () => {
  assert.fail('夹具刻意失败：assert.fail 也必须被执行到')
})
