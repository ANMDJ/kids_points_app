package com.example.kids_points_app

import android.content.Intent
import android.net.Uri
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * W10-B（2026-11-02）：App 内「立即更新」用系统浏览器打开下载地址。
 *
 * ── 为什么用 MethodChannel 而不是 `url_launcher` ────────────────────────────
 *   仓库硬约束「零第三方依赖」（README「技术说明」）。打开一个 ACTION_VIEW
 *   只需要十几行，没必要为它引入插件与两套平台配置。
 *
 * ── 为什么失败返回 false 而不是抛错 ────────────────────────────────────────
 *   设备上可能没有任何浏览器 / 系统拦了 intent。Dart 侧会退回到
 *   「复制下载链接」，这是用户唯一还能自救的路径 —— 不能让一条异常把
 *   整个更新弹窗变成崩溃。
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "kp/url_opener")
            .setMethodCallHandler { call, result ->
                if (call.method != "open") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                val url = call.argument<String>("url")
                if (url.isNullOrBlank()) {
                    result.success(false)
                    return@setMethodCallHandler
                }
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                    result.success(true)
                } catch (error: Exception) {
                    result.success(false)
                }
            }
    }
}
