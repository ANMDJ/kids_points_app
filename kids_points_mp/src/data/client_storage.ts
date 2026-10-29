import {
  getStorageSync,
  removeStorageSync,
  setStorageSync
} from '@tarojs/taro'

/**
 * 键值存储的**最小接口**（W9-A / `40` §10.3）。
 *
 * ── 为什么要这层接口，而不是直接调 `Taro.getStorageSync` ────────────────────
 *   `wx` 的 storage 在 Node 里不存在，而本仓库的客户端用例是"编译 TS → node 跑
 *   `dist/*.js`"。有了这个接口，用例注入 `MemoryKeyValueStorage` 就能把
 *   "重启后还认得我吗"这件事测成**同一条代码路径**，而不是另写一份假实现。
 *
 * ── 语义按微信来（不按 `localStorage` 来）──────────────────────────────────
 *   `getStorageSync` 在**键不存在**时返回 `''`，而不是 `null`。
 *   ⇒ [read] 把 `''` 与"没写过"视为同一件事（`null`）。
 *   这条很容易错：若把 `''` 当成有效值，token 就会变成"空串已登录"，
 *   接着发出去的是 `Authorization: Bearer `，后端只会回 401。
 */
export interface KeyValueStorage {
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): void
}

export class TaroKeyValueStorage implements KeyValueStorage {
  read(key: string): string | null {
    const raw: unknown = getStorageSync(key)
    return typeof raw === 'string' && raw !== '' ? raw : null
  }

  write(key: string, value: string): void {
    setStorageSync(key, value)
  }

  remove(key: string): void {
    removeStorageSync(key)
  }
}

/** 用例专用：不碰真 storage，可断言"到底写了几次、写了什么"。 */
export class MemoryKeyValueStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>()
  /** 写失败的键（用来模拟"存储配额满 / 平台不支持"）。 */
  private readonly failingWrites = new Set<string>()

  constructor(seed: Record<string, string> = {}) {
    Object.keys(seed).forEach((key) => this.values.set(key, seed[key]))
  }

  read(key: string): string | null {
    const value = this.values.get(key)
    return value === undefined || value === '' ? null : value
  }

  write(key: string, value: string): void {
    if (this.failingWrites.has(key)) {
      throw new Error(`模拟写 storage 失败：${key}`)
    }
    this.values.set(key, value)
  }

  remove(key: string): void {
    this.values.delete(key)
  }

  /** 让某个键的写入抛错（模拟配额满）。 */
  failWritesFor(key: string): void {
    this.failingWrites.add(key)
  }

  /** 测试断言用：这个键**现在**是什么（不写就是 undefined）。 */
  peek(key: string): string | undefined {
    return this.values.get(key)
  }

  keys(): string[] {
    return Array.from(this.values.keys())
  }
}
