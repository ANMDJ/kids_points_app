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
 *     全仓库只应有两处 `@Public()`：
 *       · `POST /auth/login`（签发凭据）
 *       · `GET /health`（若将来加健康检查）
 *     每条都要写明"为什么它可以匿名"，见 `test/identity-http.test.ts` 组 E 的守卫。
 *
 * ── ★ 它与"三道屏障"是两件事 ────────────────────────────────────────────────
 *   `@Public()` **只**跳过 `AuthGuard`。成员资格 / 权限矩阵 / 同意闸门仍各自生效
 *   （本仓库里它们本来就逐控制器显式挂载）。
 */
export const IS_PUBLIC_KEY = 'kp:isPublic'

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)
