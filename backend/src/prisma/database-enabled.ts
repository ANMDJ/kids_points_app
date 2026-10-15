/**
 * 「这台机器上到底有没有可用的数据库连接串」—— **全仓唯一口径**（W2-B 接线用）。
 *
 * ── 为什么必须有这么一个 8 行的文件（而不是各处自己 `if (process.env.DATABASE_URL)`)
 *   ① **同一件事必须只有一个判据**：W2-B 之后，四个端口
 *      （`Ledger` / `Approvals` / `Membership` / `DeviceSession`）都要做同一件事 ——
 *      「有库 ⇒ 真 Prisma 适配器；无库 ⇒ 显式 501」。四处各写一遍 `?? ''` 的判空，
 *      迟早出现三处认 `''` 为"有库"、一处不认的漂移；
 *   ② **它决定的是"哪些东西会被实例化"**：`PrismaService` 的构造函数在缺
 *      `DATABASE_URL` 时**刻意**抛错（见其文件头 —— 失败要响亮，不许静默降级成"无数据库"），
 *      而 Nest 会**急切地**实例化被导入模块的全部 provider。所以"要不要导入
 *      `PrismaModule`"这件事必须在**装配时**就有答案，不能等到第一次请求。
 *
 * ── ★ 它为什么不是"环境探测"那种味道不好的东西 ──────────────────────────────
 *   两个世界**各有各的响亮**，没有"看起来一样"的中间态：
 *     · 有连接串 ⇒ 装配真适配器，第一次查库连不上就炸（找不到孩子 ⇒ 404，不是 0 分兜底）；
 *     · 没有连接串 ⇒ 装配 `NotImplementedLedgerRepository`，**每个**方法都抛 501
 *       （可执行断言，见 `test/ledger-gate.test.ts` 组 G）。
 *   被明确排除的第三种做法是"无库时静默跳过账本写入" —— 那会让积分变成一句空承诺。
 *
 * ── 用法（不要绕过它）─────────────────────────────────────────────────────
 *   动态模块在 `register()` 里调一次：
 *     `LedgerModule.register()`                       // 按环境推断（生产/`npm start` 走这条）
 *     `LedgerModule.register({ hasDatabase: false })` // 用例显式钉住某个世界（可复现，不受本机 .env 影响）
 *   ⇒ 用例里**永远**显式传值：CI 上没有 `DATABASE_URL`、开发机上有，
 *     若靠环境推断，同一份用例在两台机器上验的是两件事。
 */
export function hasDatabaseUrl(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = env.DATABASE_URL
  // 空串 / 全空白都算"没有"。★ 与 `PrismaService` 的判空**方向一致、且更严**：
  // PrismaService 只拒 `undefined` / `''`（全空白它会放行，然后在第一次连接时炸）。
  // 这里把全空白也算"没有"，是为了让结论在**装配时**就正确 ——
  // 危险的方向只有一个：**装配说有、PrismaService 说没有**（启动即崩），本文件永不产生它。
  return typeof url === 'string' && url.trim() !== ''
}
