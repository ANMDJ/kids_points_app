import { Module } from '@nestjs/common'

/**
 * 首次引导 + 规则模板库 + 监护人同意（docs/design/04）
 *
 * 为什么引导是 W0 必须项而非可选项（04 §1）：
 *   现状首启直接进首页并展示 **seed 假数据**（124 分 / 324 好习惯），
 *   新用户看到「我完成了 324 个好习惯」—— 荒谬，也是下架 seed 的核心理由（E18）。
 *
 * `POST /onboarding/complete` 必须**原子**写入：
 *   Child.ageBand / focusAreas / onboardedAt + 采纳的 PointRule + PointRuleVersion v1 + AuditLog。
 *   `onboardedAt` 是引导的**权威状态**，服务端持有，前端不缓存（同 02 §7 的理由）。
 *
 * ★ 「采纳模板 = 复制而非引用」：采纳后即与模板脱钩 ——
 *   否则平台改一条模板会**静默改动所有家庭的规则**，绝对不可接受（04 §3）。
 *
 * 同意（04 §5）：`GuardianConsent` 必须在引导第①步取得 ——
 *   儿童个人信息的同意必须在**采集之前**取得，而第②步就开始采集昵称。
 *   未勾选时 `onboarding/complete` 返回 403 CONSENT_REQUIRED。
 *
 * ★ P2 决策（用户 2026-10-12 裁定）：模板库**不追求 90 条**，
 *   以当前设计内容为模板开发。seed 见 prisma/seed/rule-templates.ts。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 04 §6（4.1–4.12）。
 */
@Module({})
export class OnboardingModule {}
