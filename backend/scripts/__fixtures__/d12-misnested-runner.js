// ═══════════════════════════════════════════════════════════════════════════
//  D12 复现夹具 —— **不是可运行的正确测试器，而是"错误形状"的标本**
//
//  用途：证明 honesty-probe.mjs 的 C 项（D12 回归守卫）**能够失败**。
//        一个永远通过的检查等于没有检查 —— 这正是本项目 D13 的教训
//        （断言把缺陷编码成了正确行为）。
//
//  自测方式：
//    HONESTY_RUNNER_PATH=scripts/__fixtures__/d12-misnested-runner.js \
//      node scripts/honesty-probe.mjs      → C 项必须 FAIL，进程退出码 1
//
//  真实缺陷（已修）：kids_points_mp/.tmp_test/run.js 原本就是这个形状 ——
//  两个 check 回调没有在自己的位置闭合，导致 console.log('ALL PASS') 与
//  process.exitCode = 0 被**嵌进了回调内部**，在 2 个检查尚未执行时就结算，
//  此后 6 个检查即使失败也无法改变退出码 → CI 永久假绿。
// ═══════════════════════════════════════════════════════════════════════════

function check(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch {
    console.log(`FAIL  ${name}`)
  }
}

check('seed', () => {
  const seeded = 1
  void seeded

  check('addQuickNote', () => {
    const delta = 2
    void delta

    // ★ 缺陷所在：以下两行本应在**所有回调之外**（顶层），
    //   实际却落在 addQuickNote 回调内部 → 退出码在结算那一刻被锁死。
    console.log('ALL PASS')
    process.exitCode = 0
  })
})

// 说明：本夹具是**合法 JS**（花括号最终闭合），因此能被 Node 解析；
// 但它复现的正是"嵌套深度错误"这一语义缺陷。探针靠**嵌套深度**判定，
// 而不是靠语法报错 —— 因为修复前的真实 run.js 同样是合法 JS。
