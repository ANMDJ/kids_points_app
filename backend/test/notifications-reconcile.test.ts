/**
 * notifications-reconcile.test.ts —— 通知 / 推送任务对账（W6-D，2026-10-24）
 *
 * ── 这个文件在守什么 ──────────────────────────────────────────────────────
 *   ① **漂移的定义**：只有「两表找不到对面」才算漂移；`dead` / `expired` / `pending`
 *      这些**状态分布不是错误**（否则「没配网关」会让每次对账都告警）；
 *   ② **只读**：端口没有任何写方法，worker 除了读一次快照什么都不做；
 *   ③ **时间可注入**：`tick(now)` 用调用方给的时刻，而不是 `new Date()`；
 *   ④ **无库不撒谎**：501 实现抛错，**不**返回全零快照（全零 = 「一切正常」）；
 *   ⑤ **关闭开关不启动 worker**，但手动 `tick()` 仍可跑（运维临时校验用）。
 *
 * ★ 真 SQL（两处 `NOT EXISTS` 的匹配语义）由
 *   `test-db/notifications-reconcile-db.dbtest.ts` 负责 —— 离线替身永远抓不到
 *   「JSON 取出来是 null」「收件人写错一列」这类只有数据库才知道的事。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { HttpException } from '@nestjs/common'

import {
  DEFAULT_NOTIFICATIONS_RECONCILE_INTERVAL_MS,
  MAX_NOTIFICATIONS_RECONCILE_INTERVAL_MS,
  MIN_NOTIFICATIONS_RECONCILE_INTERVAL_MS,
  NOTIFICATIONS_RECONCILE_ENABLED_ENV,
  NOTIFICATIONS_RECONCILE_INTERVAL_ENV,
  NotImplementedNotificationsReconcile,
  describeReconcile,
  hasReconcileDrift,
  reconcileLogLevel,
  readNotificationsReconcileConfig,
  type NotificationsReconcileConfig,
  type NotificationsReconcilePort,
  type NotificationsReconcileSnapshot
} from '../src/notifications/notifications.reconcile'
import { NotificationsReconcileWorker } from '../src/notifications/notifications.reconcile.worker'

const NOW = new Date('2026-10-25T03:00:00.000Z')

const CONFIG: NotificationsReconcileConfig = { enabled: true, intervalMs: 300_000 }

function emptySnapshot(
  overrides: Partial<NotificationsReconcileSnapshot> = {}
): NotificationsReconcileSnapshot {
  return {
    notificationsWithoutJob: 0,
    jobsWithoutNotification: 0,
    duplicateNotifications: 0,
    pending: 0,
    sending: 0,
    sent: 0,
    dead: 0,
    expired: 0,
    oldestPendingAgeMs: null,
    checkedAt: NOW,
    ...overrides
  }
}

interface FakePort extends NotificationsReconcilePort {
  readonly calls: Date[]
  /** 让下一次 `snapshot` 抛错，用于断言 worker 不吞异常。 */
  failure: Error | null
}

function makePort(snapshot: NotificationsReconcileSnapshot = emptySnapshot()): FakePort {
  const calls: Date[] = []
  const port: FakePort = {
    calls,
    failure: null,
    async snapshot(now: Date) {
      calls.push(now)
      if (port.failure !== null) throw port.failure
      return { ...snapshot, checkedAt: now }
    }
  }
  return port
}

function makeWorker(
  port: NotificationsReconcilePort,
  config: NotificationsReconcileConfig = CONFIG
): NotificationsReconcileWorker {
  return new NotificationsReconcileWorker(port, config)
}

describe('A. 漂移的判定（纯函数）', () => {
  it('A1 全零 ⇒ 不算漂移，且日志走 debug', () => {
    const snapshot = emptySnapshot()
    assert.equal(hasReconcileDrift(snapshot), false)
    assert.equal(reconcileLogLevel(snapshot), 'debug')
  })

  it('A2 有站内通知、没有任务 ⇒ 漂移（warn）', () => {
    const snapshot = emptySnapshot({ notificationsWithoutJob: 1 })
    assert.equal(hasReconcileDrift(snapshot), true)
    assert.equal(reconcileLogLevel(snapshot), 'warn')
  })

  it('A3 有任务、没有站内通知 ⇒ 漂移（warn）', () => {
    const snapshot = emptySnapshot({ jobsWithoutNotification: 2 })
    assert.equal(hasReconcileDrift(snapshot), true)
    assert.equal(reconcileLogLevel(snapshot), 'warn')
  })

  it('A4 dead / expired / pending 只是状态分布，**不**算漂移', () => {
    // ★ 这一条最容易写错：把「没配网关导致的 expired」当成错误，
    //   会让告警在真机推送打通之前永远为真。
    const snapshot = emptySnapshot({ pending: 3, dead: 4, expired: 99, sent: 10 })
    assert.equal(hasReconcileDrift(snapshot), false)
    assert.equal(reconcileLogLevel(snapshot), 'debug')
  })

  it('A5 日志行逐字段可读，没有 pending 时写 none 而不是 0', () => {
    const line = describeReconcile(
      emptySnapshot({ notificationsWithoutJob: 1, pending: 2, oldestPendingAgeMs: null })
    )
    assert.equal(
      line,
      'notifications_without_job=1 jobs_without_notification=0 duplicate_notifications=0 ' +
        'pending=2 sending=0 sent=0 dead=0 expired=0 oldest_pending_age_ms=none'
    )
    assert.match(describeReconcile(emptySnapshot({ oldestPendingAgeMs: 65_000 })), /age_ms=65000$/)
  })

  it('A6 重复的站内通知 ⇒ 漂移（配对都齐也可能重复 —— W6-C 的唯一残留窗口）', () => {
    // ★ 这一条是「交接单里说 W6-D 会发现重复」的兑现：两边都找得到对面，
    //   只有按分组计数才能看出来。
    const snapshot = emptySnapshot({ duplicateNotifications: 1 })
    assert.equal(hasReconcileDrift(snapshot), true)
    assert.equal(reconcileLogLevel(snapshot), 'warn')
  })
})

describe('B. 配置读取（纯函数，不读 process.env）', () => {
  it('B1 缺省 ⇒ 开启、每 5 分钟一轮', () => {
    assert.deepEqual(readNotificationsReconcileConfig({}), {
      enabled: true,
      intervalMs: DEFAULT_NOTIFICATIONS_RECONCILE_INTERVAL_MS
    })
  })

  it('B2 间隔被夹到 [60s, 1h]', () => {
    assert.equal(
      readNotificationsReconcileConfig({ [NOTIFICATIONS_RECONCILE_INTERVAL_ENV]: '1000' })
        .intervalMs,
      MIN_NOTIFICATIONS_RECONCILE_INTERVAL_MS
    )
    assert.equal(
      readNotificationsReconcileConfig({
        [NOTIFICATIONS_RECONCILE_INTERVAL_ENV]: String(24 * 60 * 60_000)
      }).intervalMs,
      MAX_NOTIFICATIONS_RECONCILE_INTERVAL_MS
    )
  })

  it('B3 非数字 / 空串 ⇒ 回落默认值（不是 0，也不是 NaN）', () => {
    for (const raw of ['', '  ', 'abc', 'NaN', 'Infinity']) {
      assert.equal(
        readNotificationsReconcileConfig({ [NOTIFICATIONS_RECONCILE_INTERVAL_ENV]: raw })
          .intervalMs,
        DEFAULT_NOTIFICATIONS_RECONCILE_INTERVAL_MS,
        `raw=${JSON.stringify(raw)}`
      )
    }
  })

  it('B4 小数向下取整后再夹取', () => {
    assert.equal(
      readNotificationsReconcileConfig({
        [NOTIFICATIONS_RECONCILE_INTERVAL_ENV]: '120000.9'
      }).intervalMs,
      120_000
    )
  })

  it('B5 只有明确写成 0/false/off/no 才关闭；拼错仍保持开启', () => {
    for (const raw of ['0', 'false', 'OFF', ' no ', 'Disabled']) {
      assert.equal(
        readNotificationsReconcileConfig({ [NOTIFICATIONS_RECONCILE_ENABLED_ENV]: raw }).enabled,
        false,
        `raw=${JSON.stringify(raw)}`
      )
    }
    for (const raw of ['1', 'true', 'on', 'ofl', 'nope', '']) {
      assert.equal(
        readNotificationsReconcileConfig({ [NOTIFICATIONS_RECONCILE_ENABLED_ENV]: raw }).enabled,
        true,
        `raw=${JSON.stringify(raw)}`
      )
    }
  })
})

describe('C. worker 的 tick（只读一次、时间可注入）', () => {
  it('C1 用调用方给的时间调端口，并原样返回快照', async () => {
    const port = makePort(emptySnapshot({ pending: 1, oldestPendingAgeMs: 30_000 }))
    const worker = makeWorker(port)

    const result = await worker.tick(NOW)

    assert.equal(port.calls.length, 1)
    assert.equal(port.calls[0].getTime(), NOW.getTime())
    assert.equal(result.checkedAt.getTime(), NOW.getTime())
    assert.equal(result.pending, 1)
    assert.equal(result.oldestPendingAgeMs, 30_000)
  })

  it('C2 有漂移也照样返回（告警不等于抛错 —— 下一轮还要继续看）', async () => {
    const port = makePort(emptySnapshot({ notificationsWithoutJob: 3 }))
    const worker = makeWorker(port)

    const result = await worker.tick(NOW)

    assert.equal(result.notificationsWithoutJob, 3)
  })

  it('C3 端口抛错 ⇒ tick 向上抛（由 safeTick 记 error，不伪装成「无漂移」）', async () => {
    const port = makePort()
    port.failure = new HttpException({ code: 'BOOM' }, 500)
    const worker = makeWorker(port)

    await assert.rejects(
      () => worker.tick(NOW),
      (error: unknown) => error instanceof HttpException
    )
  })

  it('C4 每轮只调一次端口 —— 不偷偷写库、不偷偷补发', async () => {
    const port = makePort()
    const worker = makeWorker(port)

    await worker.tick(NOW)
    await worker.tick(new Date(NOW.getTime() + 300_000))

    assert.equal(port.calls.length, 2)
    // 端口只有 snapshot 一个方法 —— 若将来加了写接口，这行会直接报错。
    assert.deepEqual(Object.keys(port).sort(), ['calls', 'failure', 'snapshot'])
  })
})

describe('D. 生命周期（开关只在 worker 里解释）', () => {
  it('D1 关闭 ⇒ start() 不启动、也不调端口', async () => {
    const port = makePort()
    const worker = makeWorker(port, { ...CONFIG, enabled: false })

    worker.start()
    await new Promise((resolve) => setImmediate(resolve))
    worker.stop()

    assert.equal(port.calls.length, 0)
  })

  it('D2 关闭时手动 tick() 仍可跑（运维临时校验），stop() 幂等', async () => {
    const port = makePort()
    const worker = makeWorker(port, { ...CONFIG, enabled: false })

    await worker.tick(NOW)
    worker.stop()
    worker.stop()

    assert.equal(port.calls.length, 1)
  })

  it('D3 开启 ⇒ start() 立刻跑一轮（部署前积累的缺口不必等第一个间隔）', async () => {
    const port = makePort()
    const worker = makeWorker(port, { ...CONFIG, intervalMs: 60_000 })

    worker.start()
    // 启动即 tick 是 fire-and-forget —— 轮询而不是钉死「等一个宏任务」。
    const deadline = Date.now() + 1_000
    while (port.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    worker.stop()

    assert.equal(port.calls.length, 1)
  })
})

describe('E. 无库装配（501，不返回全零快照）', () => {
  it('E1 snapshot ⇒ 501，且错误体说明原因', async () => {
    const port = new NotImplementedNotificationsReconcile()

    await assert.rejects(
      () => port.snapshot(NOW),
      (error: unknown) => {
        assert.ok(error instanceof HttpException)
        assert.equal(error.getStatus(), 501)
        assert.match(JSON.stringify(error.getResponse()), /DATABASE_URL/)
        return true
      }
    )
  })
})

