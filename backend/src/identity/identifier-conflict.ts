import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

/**
 * `User.phone` / `User.email` 的唯一约束冲突 ⇒ **409 `IDENTIFIER_TAKEN`**
 * （W12，2026-11-02 抽出共用；原先是 `invite-registration.prisma.repository.ts` 私有）。
 *
 * ── 为什么要抽出来 ──────────────────────────────────────────────────────────
 *   现在有两条注册路径会建 `User`：家庭邀请码（`register-invite`）与网站邀请码
 *   （同一端点，但落到公开注册适配器）。两份手抄的后果不是文案不一致，
 *   而是某天只改了一条的 `field` —— 客户端按 `field` 高亮输入框，
 *   会出现「提示说邮箱重复、红框画在手机号上」。
 *
 * ── 为什么是 409 而不是 400 ─────────────────────────────────────────────────
 *   400 会让用户以为「格式不对」，于是反复改写法；真相是「这个号已经注册过，
 *   直接去登录」。两种标识分开给 `field`，让客户端能定位到具体那一栏。
 */
export function rethrowIfIdentifierTaken(error: unknown): void {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return
  if (error.code !== 'P2002') return

  const target = JSON.stringify(error.meta?.target ?? '').toLowerCase()
  if (target.includes('phone')) {
    throw new ConflictException({
      code: 'IDENTIFIER_TAKEN',
      field: 'phone',
      message:
        '这个手机号已经注册过了，请直接返回登录（忘记密码：在登录页点「忘记密码？」查看重设步骤）。'
    })
  }
  if (target.includes('email')) {
    throw new ConflictException({
      code: 'IDENTIFIER_TAKEN',
      field: 'email',
      message:
        '这个邮箱已经注册过了，请直接返回登录（忘记密码：在登录页点「忘记密码？」查看重设步骤）。'
    })
  }
}
