# 漂移夹具 · 只给 `scripts/test-can-fail.mjs` 检查项 D 用（不是真 PRD）

> 用途：证明 honesty-probe 的 **E（PRD §7 漂移守卫）有牙齿** ——
> 交给探针一份「标题数不对 + 一条判定被改 + 大量动作缺失」的文档，它必须 **FAIL** 并**点名**动作。
> 若探针在这个夹具上仍然 PASS，说明 E 是个永远通过的检查（等于没有检查）。

## 7. 权限矩阵（30 个动作 · 唯一事实源）

| 动作 | guardian | child | 归类 |
|---|---|---|---|
| `undo_check_in` | ALLOW | ALLOW | 打卡（★ 故意写错：代码里孩子是 **DENY**） |
| `view_child_points` | ALLOW | ALLOW | 查询 |

**归一化规则**：夹具到此为止。
