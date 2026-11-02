import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../widgets/form_fields.dart';
import '../widgets/soft_button.dart';

/// 提交回调：`null` = 成功，字符串 = 要显示的错误文案。
typedef CreateChildSubmit = Future<String?> Function(String name);

/// `membership == null` 的账号看到的**建孩子引导**（W10-B / P0-1）。
///
/// ── 为什么必须有这一屏 ──────────────────────────────────────────────────────
///   登录只证明"你是谁"，不证明"你在哪个孩子上有成员位"。没有成员位时
///   每一条业务请求都会 401/403；如果直接放行到首页，家长看到的是一屏
///   错误提示，而不是"你需要先建一个孩子"。
///
/// ── 为什么昵称与同意分成两步（服务端契约）──────────────────────────────────
///   后端 `POST /children` 的请求体里**只有同意**（`{consent:{accepted:true}}`），
///   昵称走随后的 `PATCH /child`。原因是"同意必须早于采集"：同一个请求里
///   先填名字再勾选，本质上仍是先采集。本屏的两次调用由 `AccountGate` 编排，
///   界面只负责收集"同意 + 昵称"。
class CreateChildScreen extends StatefulWidget {
  const CreateChildScreen({super.key, required this.onSubmit});

  final CreateChildSubmit onSubmit;

  @override
  State<CreateChildScreen> createState() => _CreateChildScreenState();
}

class _CreateChildScreenState extends State<CreateChildScreen> {
  final TextEditingController _name = TextEditingController();
  bool _agreed = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final String name = _name.text.trim();
    if (!_agreed) {
      setState(() => _error = '请先阅读并勾选同意，才能创建孩子的档案。');
      return;
    }
    if (name.isEmpty) {
      setState(() => _error = '请填写孩子的昵称。');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final String? message = await widget.onSubmit(name);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = message;
    });
  }


  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.pageTop,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const Icon(Icons.child_care_outlined,
                      size: 40, color: AppColors.primary),
                  const SizedBox(height: 14),
                  const Text(
                    '先创建一个孩子',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    '这个账号还没有加入任何家庭。\n'
                    '创建后会生成一份孩子档案，你可以随后在小程序里邀请家人。',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.6,
                      color: AppColors.textSecondary,
                    ),
                  ),
                  const SizedBox(height: 22),
                  const FieldLabel('孩子昵称'),
                  SoftTextField(
                    controller: _name,
                    hint: '例如：小明',
                    enabled: !_busy,
                    autofocus: true,
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 16),
                  Material(
                    color: AppColors.surface,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                      side: const BorderSide(color: AppColors.divider),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: CheckboxListTile(
                      value: _agreed,
                      onChanged: _busy
                          ? null
                          : (bool? next) =>
                              setState(() => _agreed = next ?? false),
                      controlAffinity: ListTileControlAffinity.leading,
                      title: const Text(
                        '我是孩子的监护人，已阅读并同意《用户协议》与《儿童个人信息保护规则》',
                        style: TextStyle(
                          fontSize: 12.5,
                          height: 1.5,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ),
                  ),
                  if (_error != null) ...<Widget>[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 11),
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
                  const SizedBox(height: 18),
                  SoftButton(
                    label: _busy ? '正在创建…' : '创建并开始',
                    icon: Icons.check_circle_outline,
                    enabled: !_busy,
                    onTap: _submit,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
