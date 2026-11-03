import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/password_rules.dart';

/// 密码强度的**客户端镜像**（2026-11-03）。
///
/// ── 这里钉的三件事 ──────────────────────────────────────────────────────────
///   ① 六条拒绝口径与判定**顺序**都和服务端一致（顺序决定用户看到哪句话）；
///   ② 六句文案与服务端 `passwordMessage()` 逐字一致（最后一条用例直接读
///      `backend/src/identity/account-identifier.ts`，改一边忘另一边会红）；
///   ③ 手机号带分隔符 / `+86`、邮箱大小写这些「库里存的值」也要能拦住
///      「密码就是自己的手机号」—— 否则本地说可以、服务端 400。
void main() {
  group('通过', () {
    test('普通强口令', () {
      expect(checkPasswordStrength('jiazhang2026').ok, isTrue);
      expect(checkPasswordStrength('jiazhang2026').message, isNull);
    });

    test('大小写不同不算「与标识相同」', () {
      expect(
        checkPasswordStrength('DadLoves2026', identifier: 'dad@example.com').ok,
        isTrue,
      );
    });
  });

  group('六条拒绝口径', () {
    test('太短 / 太长有各自的原因', () {
      expect(
        checkPasswordStrength('abc1234').failure,
        PasswordFailure.tooShort,
      );
      expect(
        checkPasswordStrength('a' * 65).failure,
        PasswordFailure.tooLong,
      );
      // 边界：8 与 64 都合法
      expect(checkPasswordStrength('abcdefg1').ok, isTrue);
      expect(checkPasswordStrength('a' * 63 + '1').ok, isTrue);
    });

    test('★ 单一字符 / 纯数字 / 常见弱口令（三句不同的话）', () {
      expect(
        checkPasswordStrength('aaaaaaaa').failure,
        PasswordFailure.allSame,
      );
      expect(
        checkPasswordStrength('20261030').failure,
        PasswordFailure.allDigits,
      );
      expect(checkPasswordStrength('Password').failure, PasswordFailure.common);
      expect(checkPasswordStrength('qwerty123').failure, PasswordFailure.common);
    });

    test('★ 与标识相同 ⇒ sameAsIdentifier（含邮箱本地部分）', () {
      expect(
        checkPasswordStrength('13800138000', identifier: '13800138000').failure,
        PasswordFailure.sameAsIdentifier,
      );
      expect(
        checkPasswordStrength('dad@example.com', identifier: 'dad@example.com')
            .failure,
        PasswordFailure.sameAsIdentifier,
      );
      expect(
        checkPasswordStrength('zhanglaoshi',
                identifier: 'zhanglaoshi@example.com')
            .failure,
        PasswordFailure.sameAsIdentifier,
      );
      // 3 字符会先被长度拦下 —— 与服务端的顺序一致。
      expect(
        checkPasswordStrength('dad', identifier: 'dad@example.com').failure,
        PasswordFailure.tooShort,
      );
    });

    test('★ 标识先按库里的形状归一化（分隔符 / +86 / 大小写）', () {
      expect(
        checkPasswordStrength('13800138000', identifier: '138-0013-8000').failure,
        PasswordFailure.sameAsIdentifier,
      );
      expect(
        checkPasswordStrength('13800138000', identifier: '+86 138 0013 8000')
            .failure,
        PasswordFailure.sameAsIdentifier,
      );
      expect(
        checkPasswordStrength('dad@example.com', identifier: ' DAD@Example.COM ')
            .failure,
        PasswordFailure.sameAsIdentifier,
      );
    });
  });

  group('文案', () {
    test('每一句都能指出下一步怎么改', () {
      expect(
        passwordFailureMessage(PasswordFailure.tooShort),
        '密码至少 8 位。',
      );
      expect(
        passwordFailureMessage(PasswordFailure.tooLong),
        '密码最多 64 位（太长的密码只是给自己添麻烦）。',
      );
      expect(
        passwordFailureMessage(PasswordFailure.allSame),
        '密码不能是同一个字符重复。',
      );
      expect(
        passwordFailureMessage(PasswordFailure.allDigits),
        '密码不能全是数字，请至少带一个字母。',
      );
      expect(
        passwordFailureMessage(PasswordFailure.common),
        '这个密码太常见了，很容易被猜到，请换一个。',
      );
      expect(
        passwordFailureMessage(PasswordFailure.sameAsIdentifier),
        '密码不能和你的手机号或邮箱一样。',
      );
    });

    test('★ 常驻提示把六条要求都说全（不是只有「8 位」）', () {
      expect(kPasswordRequirementHint, contains('8–64 位'));
      expect(kPasswordRequirementHint, contains('至少含一个字母'));
      expect(kPasswordRequirementHint, contains('纯数字'));
      expect(kPasswordRequirementHint, contains('常见弱密码'));
      expect(kPasswordRequirementHint, contains('手机号/邮箱'));
    });
  });

  test('★ 与服务端同一份规则：阈值 / 弱口令表 / 文案逐字对得上', () {
    // 读取后端源文件而不是复制期望值：这是本文件存在的**主要**价值。
    // 文件不存在 ⇒ 直接失败（「没验证」不等于「通过」）。
    final File source = File('backend/src/identity/account-identifier.ts');
    expect(source.existsSync(), isTrue,
        reason: '找不到服务端规则文件；不要在找不到时静默跳过');
    final String ts = source.readAsStringSync();

    expect(ts, contains('export const PASSWORD_MIN = $kPasswordMin'));
    expect(ts, contains('export const PASSWORD_MAX = $kPasswordMax'));

    // 服务端这两句是模板字面量（内插常量），所以比对的是模板写法。
    expect(ts, contains(r'`密码至少 ${PASSWORD_MIN} 位。`'));
    expect(ts, contains(r'`密码最多 ${PASSWORD_MAX} 位（太长的密码只是给自己添麻烦）。`'));
    // 其余四句是普通字符串，逐字可比。
    for (final PasswordFailure reason in <PasswordFailure>[
      PasswordFailure.allSame,
      PasswordFailure.allDigits,
      PasswordFailure.common,
      PasswordFailure.sameAsIdentifier,
    ]) {
      expect(ts, contains(passwordFailureMessage(reason)),
          reason: '文案漂移：$reason');
    }

    // 弱口令表：客户端少一条就会「本地放行、服务端 400」。
    for (final String weak in <String>[
      '12345678',
      '123456789',
      '1234567890',
      'password',
      'password1',
      'passw0rd',
      'qwertyui',
      'qwerty123',
      'abc12345',
      'iloveyou',
      'admin123',
      '1qaz2wsx',
      'zxcvbnm1',
      'woaini1314',
    ]) {
      expect(ts, contains("'$weak'"), reason: '服务端弱口令表缺少 $weak');
      expect(kCommonPasswords, contains(weak), reason: '客户端弱口令表缺少 $weak');
      // 表里有的每一条都必须真的被拒（`12345678` 这类会先命中「纯数字」，
      // 所以不断言具体是哪一支，只断言「不放行」）。
      expect(checkPasswordStrength(weak).ok, isFalse,
          reason: '客户端放行了服务端列为弱口令的密码：$weak');
    }
  });
}
