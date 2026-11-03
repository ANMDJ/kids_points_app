import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../models/invite.dart';
import '../../theme/app_colors.dart';
import '../../widgets/form_fields.dart';
import '../../widgets/sheet_frame.dart';
import '../family_join_actions.dart';

/// 打开「输入邀请码加入家庭」面板（`43` §0 **P0-3**，2026-11-03）。
///
/// ── 为什么动作要在打开之前取 ────────────────────────────────────────────────
///   `showModalBottomSheet` 把内容挂到 Navigator 的 Overlay 上，而
///   `FamilyJoinActions` 由 `AccountGate` 提供（在 `MaterialApp.home` 之下）——
///   弹窗里查不到它。这与 `showInviteSheet` 先取 `AppStore` 是同一手法。
///
/// ── 为什么不在这里刷新首页 ──────────────────────────────────────────────────
///   加入成功后 `AccountGate` 会把 `childId` 写进 `SessionScope`，
///   而 `signedIn` 子树以 childId 为 key（`account_gate.dart`）⇒ `HomeShell`
///   整体重建，它的 `didChangeDependencies` 会自动拉一次新家庭的首页。
///   再手动 `refreshFromServer()` 就是同一秒内的第二个 `GET /home`。
Future<void> showJoinFamilySheet(BuildContext context) async {
  final FamilyJoinActions? actions = FamilyJoinActions.maybeOf(context);
  // 预览模式 / 未登录：入口本身就不会画（见「我的」页），这里再兜一次。
  if (actions == null) return;
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

  final bool? joined = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return JoinFamilySheet(joinFamily: actions.joinFamily);
    },
  );
  if (joined != true) return;

  messenger.hideCurrentSnackBar();
  messenger.showSnackBar(
    const SnackBar(content: Text('已加入家庭，正在切换到这个家庭的数据…')),
  );
}

/// 「加入家庭」面板：一个输入框 + 一句本地校验 + 服务端原文错误。
///
/// ── 本地校验只做**形状**，不做「码能不能用」────────────────────────────────
///   形状（8 位 / 31 个易辨认字符）是纯函数，本地能判就本地判 ——
///   少抄一位时不必先等一次往返再被 400 拒。而「这个码过期了 / 用完了 /
///   被吊销了 / 你已经是成员了」只有服务端知道，**必须**由服务端回答：
///   客户端自己猜会把「码还能用」误判成失效（家长会白白再发一张）。
///
/// ── 四种「不可用」为什么只有三句文案 ────────────────────────────────────────
///   后端 `invite-claim.ts` 故意把「不存在 / 过期 / 用完 / 吊销」收敛成同一个
///   409 `INVITE_CODE_UNAVAILABLE` —— 区分它们等于给端点一个「哪些码存在」的
///   探测面。所以客户端能区分的只有三类：
///     ① 形状不对（400 `INVITE_CODE_MALFORMED`，本地也会先拦）；
///     ② 码现在不能用（409 `INVITE_CODE_UNAVAILABLE`）；
///     ③ 你已经是这个家庭的成员（409 `ALREADY_MEMBER`，**不消耗**名额）。
class JoinFamilySheet extends StatefulWidget {
  const JoinFamilySheet({super.key, required this.joinFamily});

  /// `null` = 成功；字符串 = 要显示的错误文案（见 `FamilyJoinActions`）。
  final Future<String?> Function(String code) joinFamily;

  @override
  State<JoinFamilySheet> createState() => _JoinFamilySheetState();
}

class _JoinFamilySheetState extends State<JoinFamilySheet> {
  final TextEditingController _code = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    // 输入框里可能是 `abcd-efgh` / `ABCD EFGH` / 前后带空格 ——
    // 与后端 `normalizeInviteCode()` 同一条规则（去空白与连字符、转大写）。
    final String code = normalizeInviteCodeInput(_code.text);
    if (code.isEmpty) {
      setState(() => _error = '请先输入邀请码。');
      return;
    }
    if (!isWellFormedInviteCode(code)) {
      setState(() {
        _error = '邀请码是 $kInviteCodeLength 位字母数字（不含 0/O/1/I/L），'
            '现在输入的是 ${code.length} 位。请检查是否抄漏或抄错了字符。';
      });
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    final String? message = await widget.joinFamily(code);
    if (!mounted) return;
    if (message == null) {
      // 成功：把结果交回 `showJoinFamilySheet`（它负责提示与切换）。
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _busy = false;
      _error = message;
    });
  }

  @override
  Widget build(BuildContext context) {
    return SheetFrame(
      title: '加入家庭',
      subtitle: '输入家长发给你的邀请码，就能看到这个家庭的积分和心愿',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          const FieldLabel('邀请码'),
          SoftTextField(
            controller: _code,
            hint: '例如 ABCD-EFGH',
            enabled: !_busy,
            autofocus: true,
            // 大写 + 字距：码里没有小写，用户抄的是大写；拉开字距便于逐位核对。
            style: const TextStyle(
              fontSize: 18,
              letterSpacing: 3,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
            inputFormatters: <TextInputFormatter>[
              // 只允许字母 / 数字 / 空格 / 连字符：中文输入法里误按的字符
              // 会在提交时变成「数了几位都不对」，不如根本不让它进来。
              FilteringTextInputFormatter.allow(RegExp(r'[A-Za-z0-9\s-]')),
              LengthLimitingTextInputFormatter(32),
            ],
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 8),
          const Text(
            '8 位字母数字，不含容易认错的 0 / O / 1 / I / L；连字符可省略。\n'
            '加入后会切换到这个家庭 —— 你自己的家庭不会消失，下次登录仍在。',
            style: TextStyle(
              fontSize: 11.5,
              height: 1.6,
              color: AppColors.textSecondary,
            ),
          ),
          if (_error != null) ...<Widget>[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              decoration: BoxDecoration(
                color: AppColors.chipBg,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: AppColors.pointSpend.withValues(alpha: 0.25),
                ),
              ),
              child: Text(
                _error!,
                style: const TextStyle(
                  fontSize: 12.5,
                  height: 1.5,
                  color: AppColors.pointSpend,
                ),
              ),
            ),
          ],
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: Text(_busy ? '正在加入…' : '加入'),
          ),
        ],
      ),
    );
  }
}
