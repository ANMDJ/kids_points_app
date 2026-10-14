import { Module } from '@nestjs/common'

/**
 * 审批（docs/design/02 §4）
 *
 * 状态机：pending → approved | rejected | withdrawn | invalidated | expired
 * ★ `invalidated`（第 5 个终态）不可省略 —— 审批是**跨时间**的：
 *   家长 3 小时后才点「同意」时，前提可能已消失（心愿被删 / 积分被花掉 /
 *   规则被删 / 成员被移出）。没有它就只能返回 500 或静默丢弃（02 §4.2）。
 *
 * ★ `rejected` 与 `invalidated` 的语义**必须在 UI 上区分**：
 *   rejected    = 家长不同意（人的决定）→「爸爸说这次先不换」
 *   invalidated = 前提消失了（系统判定）→「这个心愿已经不在心愿单里了」
 *   混用会让家长「莫名其妙背锅」—— 必须避免的体验缺陷。
 *
 * 批准执行必须**幂等**（02 §4.4）：
 *   UPDATE ... WHERE id = ? AND status = 'pending'  ← 乐观锁，单条条件 UPDATE
 *   未命中 → 409 ALREADY_DECIDED（防双击）；命中 → 同事务写账本 + status + executedRecordId
 *
 * ★ **谁可以批准**（2026-10-14 裁定 P4）：审批**不额外定义"批准人名单"** ——
 *   批准资格 = 矩阵的 `review_approvals` 行；**申请人本人可以自批，但必须显式**
 *   （① 提交后本人二次确认，或 ② 申请时勾选"自动审批"）。缺省一律 `pending`，
 *   绝不因为"只有一位家长"就自动批准。判据见 `src/contracts/approval-policy.ts`（02 §4.5），
 *   本模块**必须消费它**，不得在 controller / service 里另写一份。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 02 §9.3 / §9.7 / §9.8 / §9.10 / §9.25–§9.27。
 */
@Module({})
export class ApprovalsModule {}
