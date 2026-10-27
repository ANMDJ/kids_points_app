/**
 * deletion-worker.test.ts —— 执行 worker 的**调度语义**（W7-D，2026-10-27）
 *
 * 它证明的是「什么时候扫、扫多少、并发时怎么办、失败怎么办」：
 *   · `tick(now)` 把**指定时刻**与 `batchSize` 交给端口（用例可精确驱动“到期”）；
 *   · 单飞：一轮未结束时再 tick，不会开第二轮；
 *   · `tick()` 的错误**向上抛**（调用方必须看得见）；定时器回调 `safeTick()` 才吞；
 *   · `start()` 幂等、禁用时不 tick、`onApplicationShutdown()` 等在途结束。
 *
 * ★ 它**不**证明真库上删得对 —— 那是 `test-db/deletion-db.dbtest.ts`。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  CancelDeletionInput,
  DeletionPort,
  ExecutedDeletion,
  ExecuteDueInput,
  RequestDeletionInput
} from '../src/deletion/deletion.repository'
import {
  FamilyDeletionWorker,
  type DeletionWorkerConfig
} from '../src/deletion/deletion.worker'
import { makeDeletionState } from './support/deletion-fake'

const CONFIG: DeletionWorkerConfig = { enabled: true, intervalMs: 60_000, batchSize: 3 }
const NOW = new Date('2026-11-03T00:00:00.000Z')

const EXECUTED: ExecutedDeletion[] = [
  {
    requestId: 'req-1',
    childId: 'child-1',
    summary: {
      coolingDays: 7,
      redacted: {
        child: 1,
        members: 1,
        rules: 0,
        ruleVersions: 0,
        habits: 0,
        wishes: 0,
        records: 0,
        approvals: 0,
        consents: 0,
        notifications: 0
      },
      kept: { records: 0, pointsBalance: 0 },
      note: 'n'
    }
  }
]

interface WorkerFake extends DeletionPort {
  calls: ExecuteDueInput[]
  resolveNext(value: ExecutedDeletion[]): void
  rejectNext(error: Error): void
  attempted: number
}

/** 端口替身：`executeDue` 挂起，直到用例显式 resolve / reject。 */
function makePort(): WorkerFake {
  const calls: ExecuteDueInput[] = []
  const waiters: Array<{ resolve: (v: ExecutedDeletion[]) => void; reject: (e: Error) => void }> = []
  return {
    calls,
    attempted: 0,
    resolveNext(value) {
      waiters.shift()?.resolve(value)
    },
    rejectNext(error) {
      waiters.shift()?.reject(error)
    },
    async readState(childId) {
      return makeDeletionState('none', NOW)
    },
    async requestDeletion(input: RequestDeletionInput) {
      return makeDeletionState('pending', input.now)
    },
    async cancelDeletion(input: CancelDeletionInput) {
      return makeDeletionState('cancelled', input.now)
    },
    executeDue(input) {
      calls.push(input)
      return new Promise<ExecutedDeletion[]>((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
    }
  }
}

describe('tick：把「时刻 + 批量」原样交给端口，并返回执行结果', () => {
  it('传 now / limit；返回端口给出的事件（不重新拼一份）', async () => {
    const port = makePort()
    const worker = new FamilyDeletionWorker(port, CONFIG)

    const running = worker.tick(NOW)
    await Promise.resolve()
    assert.deepEqual(port.calls, [{ now: NOW, limit: 3 }])

    port.resolveNext(EXECUTED)
    assert.deepEqual(await running, EXECUTED)
  })
})

describe('单飞：一轮未结束时的第二次 tick 复用同一个 Promise', () => {
  it('端口只被调用一次；两个调用者拿到同一份结果', async () => {
    const port = makePort()
    const worker = new FamilyDeletionWorker(port, CONFIG)

    const first = worker.tick(NOW)
    const second = worker.tick(NOW)
    await Promise.resolve()

    assert.equal(port.calls.length, 1, '并发 tick 开了第二轮 —— 同一批请求会被两条链同时领')

    port.resolveNext(EXECUTED)
    const [a, b] = await Promise.all([first, second])
    assert.deepEqual(a, EXECUTED)
    assert.deepEqual(b, EXECUTED)
  })

  it('一轮结束后可以再 tick（单飞不是「只跑一次」）', async () => {
    const port = makePort()
    const worker = new FamilyDeletionWorker(port, CONFIG)

    const first = worker.tick(NOW)
    await Promise.resolve()
    port.resolveNext([])
    await first

    const second = worker.tick(NOW)
    await Promise.resolve()
    assert.equal(port.calls.length, 2)
    port.resolveNext([])
    await second
  })
})

describe('失败：tick 抛给调用方（定时器才吞）', () => {
  it('端口 reject ⇒ tick reject；下一轮仍可继续', async () => {
    const port = makePort()
    const worker = new FamilyDeletionWorker(port, CONFIG)

    const failed = worker.tick(NOW)
    await Promise.resolve()
    port.rejectNext(new Error('db down'))
    await assert.rejects(failed, /db down/)

    const retry = worker.tick(NOW)
    await Promise.resolve()
    assert.equal(port.calls.length, 2)
    port.resolveNext([])
    assert.deepEqual(await retry, [])
  })
})

describe('start / shutdown：幂等、可禁用、等在途结束', () => {
  it('禁用 ⇒ 不 tick', async () => {
    const port = makePort()
    const worker = new FamilyDeletionWorker(port, { ...CONFIG, enabled: false })

    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(port.calls.length, 0)
    await worker.onApplicationShutdown()
  })

  it('启动即扫一轮；重复 start 不叠定时器；关停后在途结束才返回', async () => {
    const port = makePort()
    const worker = new FamilyDeletionWorker(port, CONFIG)

    worker.start()
    worker.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(port.calls.length, 1, '启动扫描没有发生，或 start 叠出了第二个定时器')

    const shutdown = worker.onApplicationShutdown()
    let closed = false
    void shutdown.then(() => {
      closed = true
    })
    await Promise.resolve()
    assert.equal(closed, false, '还有在途的一轮就返回了 —— 关停没有等它')

    port.resolveNext([])
    await shutdown
    assert.equal(closed, true)
  })
})
