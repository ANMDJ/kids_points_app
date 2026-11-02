import { SetMetadata } from '@nestjs/common'

/**
 * 标记"**不需要登录**"的路由（W9-A，2026-10-29）。
 *
 * ── 为什么需要它（而"不挂 Guard"不行）────────────────────────────────────────
 *   `AuthGuard` 注册成 `APP_GUARD`（全局），它会在**每一个**路由前运行。
 *   而 `POST /auth/login` 的用途恰恰是**签发**凭据 —— 它不能要求凭据（`40` §8.2）。
 *   若靠"这个路由别挂 Guard"来解决，就得放弃全局注册、改成 17 个控制器逐个挂
 *   —— 那会引入本仓库最怕的那种失败：**漏一个控制器**，于是一条本该要身份的路由
 *   悄悄变成匿名可访问，而且没有任何测试会因为"少挂一个"变红（除非恰好有人为它写用例）。
 *
 *   ⇒ 全局默认**要求身份**，例外必须**显式标在这里**。
 *     全仓库只应有三处 `@Public()`，且判据只有一条 —— **要么响应里没有任何凭据，
 *     要么它**就是**签发凭据的那一个**（后半句是 W9-D 补的，见下）：
 *       · `POST /auth/login`（`identity.controller.ts`）—— 它**签发**第一个 token，
 *         自然不能要求 token，否则是自举死锁；
 *       · `POST /auth/login-account`（`identity.controller.ts`，W9-D）—— 同上，
 *         它是"手机号/邮箱 + 密码"那条签发路径，返回**同一种** `AuthSession` token。
 *         ★ 它不是第二个例外类别：`/auth/login` 与它合起来才算"签发凭据的那一个入口"。
 *         加它的判据与加第一条完全一样 —— 不返回凭据的路由不许匿名，
 *         签发凭据的路由**只能**是这两条；
 *       · `POST /auth/date-code`（`identity.controller.ts`）—— 只回
 *         `{ valid, serverDate, weekDay, … }`：固定规则的码可推导，它**不是**
 *         认证凭据，任何"通过后给你点什么"的改动都会让它失去匿名的资格；
 *       · `GET /app/version`（`app-version.controller.ts`，W10-B）—— 只回公开的
 *         版本号 / 下载地址 / 更新说明，**不读用户数据、不签发凭据、不改变状态**。
 *         客户端必须在登录**之前**就能检查更新：否则"版本太旧登不进去"时
 *         没有任何自救路径。★ 它是第四条，判据与上面三条完全相同；
 *       · `GET /health`（若将来加健康检查）。
 *     ★ "客户端现在还没登录"**不是**可以匿名的理由 —— 那条理由会让每一条新路由
 *       都想匿名。判据只看响应形状。
 *     每条都要写明"为什么它可以匿名"，见 `test/identity-http.test.ts` 组 E 的守卫。
 *
 * ── ★ 它与"三道屏障"是两件事 ────────────────────────────────────────────────
 *   `@Public()` **只**跳过 `AuthGuard`。成员资格 / 权限矩阵 / 同意闸门仍各自生效
 *   （本仓库里它们本来就逐控制器显式挂载）。
 */
export const IS_PUBLIC_KEY = 'kp:isPublic'

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)
