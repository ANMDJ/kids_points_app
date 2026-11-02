# AGENTS.md —— 给 AI 协作者的项目约束

> 只写「不写就一定会反复犯」的硬约束。产品/设计事实见 [`docs/design/`](./docs/design/README.md)，
> 需求口径见 [`docs/PRD.md`](./docs/PRD.md)。本文件由 Cline 作为工作区规则自动加载。

## 1. 搜索纪律：编译产物不是证据

**禁止把构建产物当搜索目标。** 具体路径（全部已在 `.gitignore` 里）：

| 类别 | 路径 |
|---|---|
| Flutter / Dart | `build/`、`.dart_tool/`、`.widget_preview/`、`*.iml` |
| 后端 | `backend/dist/`、`backend/.tmp_test_build/`、`backend/node_modules/` |
| 小程序 / H5 | `kids_points_mp/dist/`、`kids_points_mp/node_modules/`、`.tmp_test/dist/`、`.tmp_test/chrome-profile/` |
| 原生 | `ios/Pods/`、`ios/Flutter/ephemeral/`、`ios/Flutter/Generated.xcconfig`、`ios/Flutter/flutter_export_environment.sh`、`android/.gradle/` |
| 日志 | `*.log`（仓库根还堆着几十个 `.tmp_*.log` 探针日志） |

判断依据（不是偏好，是可验证的事实）：

- **它们不入库**。`git ls-files build .dart_tool` → **0 行**；`git check-ignore -v` 对
  `.dart_tool`、`build`、`backend/dist`、`.widget_preview`、`node_modules` 全部命中各自
  `.gitignore`。提交里没有的东西，本来就不该成为排查证据。
- **代价实测**（2026-11-02，cline-core 4.1.26）：内置 `search_codebase` 报
  `Searched 1519 files`，而提交口径只有 **793** 个文件 —— 差额 726 个几乎全是生成物；
  同一查询 `flutter_build|package_config` 的 17 条命中 **100%** 落在
  `.widget_preview/.dart_tool/**` 与 `ios/Flutter/ephemeral/**`，对定位 bug 零贡献。
- **它挡不住**：`search_codebase` 没有路径过滤参数，其内置黑名单
  `node_modules / vendor / .git / dist / build / .next / coverage / __pycache__ / .venv / venv /
  .cache / .turbo / .output / out / target / bin / obj` 里**没有** `.dart_tool`、
  `.widget_preview`、`ios/Flutter/ephemeral`；`.ignore` / `.gitignore` 对它无效
  （详见 `.ignore` 文件头的实测附注）。

### 怎么做

1. **仓库级检索用命令，不用工具**：
   `node tools/search-tracked.mjs '<正则>'`（文件集 = `git ls-files --cached --others --exclude-standard`，
   即「未来 commit 可能包含的全部文件」；另有产物硬黑名单兜底与 `--self-test` 自检）。
   支持 `--case-sensitive / --context N / --max N / --files-only`。
2. **用 `search_codebase` 时**：pattern 必须带业务标识（`Idempotency-Key`、`invite`、
   `RelationKind` 之类），**不要**用 `widget`、`build`、`config`、`version` 这种会吸满生成物的词；
   命中里一旦出现上表路径，直接判为噪音，不进结论。
3. **确实要看产物内容**（例如「打出来的包里写的是什么版本号」）：先确定具体文件路径，再用
   `read_files` 读那一个文件；**不做**全仓 pattern 搜索。
4. **查编译类问题的正确顺序**：拿编译器的 `EXIT` 码 + 报错原文 → 读报错点名的源文件 →
   读相关配置（`pubspec.yaml`、`tsconfig`、`nest-cli.json`、`prisma/schema.prisma`）→ 必要时重跑命令。
   产物里永远不会写着「为什么编译不过」。

## 2. 变更记录

| 日期 | 变更 | 起因 |
|---|---|---|
| 2026-11-02 | 新增本节 + `tools/search-tracked.mjs`；`.ignore` 头部的实测附注同步更新 | 检索命中被 `.dart_tool/**`、`.widget_preview/.dart_tool/**`、`ios/Flutter/ephemeral/**` 淹没（1519 vs 793）；`.ignore` 对 `search_codebase` 无效 |
