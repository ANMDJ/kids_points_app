# contracts/ —— 跨语言共享契约

> ⚠ **本目录下的 `*.json` 是生成产物，请勿手工编辑。**
> 手改会在下一次 `npm run contracts:emit` 时被覆盖，且**不会报错** ——
> 那正是最危险的一类改动：看起来生效了，实际在下一次构建时静默回退。

## 为什么这个目录必须存在

`02` §2 的架构约束是：**权限只能在一处定义**。HTTP Guard 与 Agent `action-dispatcher`
**必须消费同一张表**，否则两条入口必然漂移 —— 而漂移的后果是
**Agent 成为提权通道**（`02` §3 屏障二的反面）。

但 `backend_agent` 是 **Python**，无法 `import` TypeScript。
若让它自己抄一份矩阵，约束就只能靠自觉维持 —— 那不是约束。

## 唯一事实源

```
backend/src/contracts/permission-matrix.ts      ← 唯一事实源（TypeScript）
        │  npm run build && npm run contracts:emit
        ▼
contracts/permission-matrix.json                ← 生成产物（本目录）
```

> 关于路径：`02` §2 示意路径为 `contracts/permission-matrix.ts`。
> 实际落在 `backend/src/contracts/` —— 因为 TS 源码若放在仓库根目录，
> 会跨出 backend 的 `rootDir`，导致 `dist` 目录结构变成 `dist/backend/src/main.js`，
> 进而影响 `nest start` 的默认入口。**唯一事实源的本质是「只有一份」，不是「放在哪个目录」。**
> 见 `docs/design/06-w0-report.md` §3「待确认决策 D8」。

## 生成方式

```bash
cd backend
npm run build          # 必须先 build —— 本脚本读取编译产物，而非解析 TS 源码文本
npm run contracts:emit
```

**为什么读编译产物而不是正则解析 `.ts`**：解析源码文本是脆弱的 ——
一次格式化或重命名就可能**静默漏掉一个动作**，而漏掉的动作会被 Agent 视为未知并拒绝
（fail-closed，尚可接受），也可能因疏漏被放行（不可接受）。编译产物不会说谎。

## Python Agent 侧如何消费

```python
import json, pathlib

_MATRIX = json.loads(
    pathlib.Path(__file__).parents[2].joinpath("contracts/permission-matrix.json").read_text("utf-8")
)

def resolve_verdict(action: str, role: str) -> str:
    """与 backend/src/contracts/permission-matrix.ts 的 resolveVerdict 语义一致。

    ★ fail-closed：未知动作 / viewer / 未知角色一律 DENY。
    """
    if role not in ("guardian", "child"):
        return "DENY"
    return _MATRIX["matrix"].get(action, {}).get(role, "DENY")
```

**Agent 侧不得**：
- 自行补充动作名（矩阵里没有的动作 = 不存在这个动作）
- 覆盖 `verdictSeverity` 的排序（`DENY > REQUIRE_APPROVAL > ALLOW` 是屏障三方向性的依据）
- 缓存后长期不刷新（矩阵更新后 Agent 行为会与 Guard 不一致）

## 一致性校验

`backend/scripts/honesty-probe.mjs` 的 **D 项** 会校验
`permission-matrix.ts` 的动作集合与 Prisma `enum ActionType` 逐一对应。
若两侧漂移，探针退出码为 1。

> 若将来矩阵需要变更，正确顺序是：
> ① 改 `permission-matrix.ts` → ② 改 `schema.prisma` 枚举 → ③ 跑探针确认一致
> → ④ `npm run contracts:emit` → ⑤ Agent 重启加载新矩阵。
