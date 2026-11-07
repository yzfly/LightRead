package com.yzfly.lightread

// 覆盖 `tauri android init` 生成的 MainActivity (CI 在 init 后复制进 gen/android)。
// edge-to-edge 下网页铺到系统栏之下; 旧版 System WebView (如 Android 12 + Chromium 135)
// 不给 env(safe-area-inset-*) 赋值, 这里把系统栏 + 刘海的实际尺寸 (CSS px) 经
// window.LightReadInsets 交给前端 src/services/systemBars.ts; 前端再按页面实际深浅
// 回调 setBarsDark 切换状态栏 / 导航栏图标颜色。
//
// 音量键翻页: 阅读页经 setVolumeKeys(true) 打开后, 音量上 / 下不再调音量, 而是回调
// window.__lightreadVolumeKey('prev' | 'next') (前端 src/services/systemBars.ts)。
//
// 选字菜单: 阅读页有自己的划线工具条, 经 setSelectionMenu(false) 让 WebView 的浮动选字菜单
// (复制 / 全选 / 网页搜索…) 不再出现, 只保留选区与把手; 输入框获得焦点时前端再打开, 保留粘贴。
//
// 书摘分享 (window.LightReadShare, 前端 src/services/shareOut.ts): 金句卡片存进相册
// (MediaStore Pictures/LightRead, Android 10+ 无需存储权限), 图片 / 文本 / 笔记文件
// 经系统分享面板发到微信、笔记应用等; 分享用的临时文件放 cacheDir/share/ 并经 FileProvider 授权。
// 划词翻译也经这个桥列出 / 拉起本机能处理文字的应用 (ACTION_PROCESS_TEXT, 前端 src/services/translate.ts)。

//
// 应用内更新 (window.LightReadUpdater, 前端 src/services/updater.ts): Rust 把校验过的安装包
// 放在 cacheDir/updates/<name>.apk, 这里用 FileProvider (tauri init 自带, cache-path) 交给
// 系统安装器。没开「安装未知应用」时由前端引导到该设置页, 回来后再调 install。
// 清单需要 REQUEST_INSTALL_PACKAGES, 由 scripts/patch-android-project.mjs 在 init 后补上。

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import java.io.File
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  // Some Android WebViews keep document.hidden/hasFocus unchanged after Home.
  @Volatile
  private var activityResumed = false

  override fun onResume() {
    super.onResume()
    activityResumed = true
  }

  override fun onPause() {
    activityResumed = false
    super.onPause()
  }

  private inner class LifecycleBridge {
    @JavascriptInterface
    fun isForeground(): Boolean = activityResumed
  }

  @Volatile
  private var insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    Thread { cleanInstalledUpdates() }.start()
  }

  @Volatile
  private var volumeKeysOn = false

  @Volatile
  private var selectionMenuOn = true

  /**
   * WebView 的浮动选字菜单经父视图 startActionModeForChild 创建. 不能在 Activity.onWindowStartingActionMode
   * 里包: 它对浮动菜单返回 null 时 DecorView 会改用自己包的原始回调, 我们的包装被丢掉 (K30 实测菜单照旧出现).
   * 所以给 WebView 套一层父布局, 在这里换成 QuietSelectionCallback; 关闭时清空菜单项, 选区与把手不受影响.
   * 不能让 onCreateActionMode 返回 false: Chromium 会当作失败并清掉选区.
   */
  private inner class SelectionMenuFrame(context: Context) : FrameLayout(context) {
    override fun startActionModeForChild(originalView: View, callback: ActionMode.Callback, type: Int): ActionMode? =
      super.startActionModeForChild(originalView, if (type == ActionMode.TYPE_FLOATING) QuietSelectionCallback(callback) else callback, type)
  }

  private fun wrapForSelectionMenu(webView: WebView) {
    val parent = webView.parent as? ViewGroup ?: return
    if (parent is SelectionMenuFrame) return
    val index = parent.indexOfChild(webView)
    val lp = webView.layoutParams
    parent.removeView(webView)
    val frame = SelectionMenuFrame(this)
    frame.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    parent.addView(frame, index, lp)
  }

  private inner class QuietSelectionCallback(private val inner: ActionMode.Callback) : ActionMode.Callback2() {
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean =
      inner.onCreateActionMode(mode, menu).also { if (!selectionMenuOn) menu.clear() }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean =
      inner.onPrepareActionMode(mode, menu).also { if (!selectionMenuOn) menu.clear() }

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean = inner.onActionItemClicked(mode, item)

    override fun onDestroyActionMode(mode: ActionMode) = inner.onDestroyActionMode(mode)

    override fun onGetContentRect(mode: ActionMode, view: View, outRect: android.graphics.Rect) {
      if (inner is ActionMode.Callback2) inner.onGetContentRect(mode, view, outRect)
      else super.onGetContentRect(mode, view, outRect)
    }
  }
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(InsetsBridge(), "LightReadInsets")
    // wry 可能在这之后才把 WebView 放进布局: 已有父视图就下一帧套上, 否则等它挂上窗口
    if (webView.parent != null) webView.post { wrapForSelectionMenu(webView) }
    else webView.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(v: View) {
        v.removeOnAttachStateChangeListener(this)
        v.post { wrapForSelectionMenu(webView) }
      }
      override fun onViewDetachedFromWindow(v: View) {}
    })
    webView.addJavascriptInterface(UpdaterBridge(), "LightReadUpdater")
    webView.addJavascriptInterface(LifecycleBridge(), "LightReadLifecycle")
    webView.addJavascriptInterface(ShareBridge(), "LightReadShare")

    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      fun css(px: Int) = px / density
      insetsJson = "{\"top\":${css(bars.top)},\"right\":${css(bars.right)}," +
        "\"bottom\":${css(bars.bottom)},\"left\":${css(bars.left)}}"
      (view as WebView).evaluateJavascript("window.__lightreadApplyInsets?.()", null)
      // 交还 WebView 自身的处理, 新版 Chromium 仍据此填充 env()
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /** 按下 (含长按连发) 时翻页; 抬起也要吞掉, 否则系统会弹出音量条 */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (volumeKeysOn) {
      val key = when (event.keyCode) {
        KeyEvent.KEYCODE_VOLUME_UP -> "prev"
        KeyEvent.KEYCODE_VOLUME_DOWN -> "next"
        else -> null
      }
      if (key != null) {
        if (event.action == KeyEvent.ACTION_DOWN) {
          webView?.evaluateJavascript("window.__lightreadVolumeKey?.('$key')", null)
        }
        return true
      }
    }
    return super.dispatchKeyEvent(event)
  }

  private var barsDark: Boolean? = null

  private fun applyBarsDark(dark: Boolean) {
    if (barsDark == dark) return
    barsDark = dark
    // 透明系统栏, 仅切换图标深浅; 背景由网页自身延伸到栏下
    val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
      else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
    enableEdgeToEdge(style, style)
  }

  /** 沉浸阅读: 隐藏状态栏与导航栏 (从屏幕边缘滑动可临时呼出) */
  private fun applyImmersive(on: Boolean) {
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    if (on) {
      controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      controller.show(WindowInsetsCompat.Type.systemBars())
    }
  }

  private fun applyKeepScreenOn(on: Boolean) {
    if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  private inner class InsetsBridge {
    @JavascriptInterface
    fun setImmersive(on: Boolean) {
      runOnUiThread { applyImmersive(on) }
    }

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
      runOnUiThread { applyKeepScreenOn(on) }
    }

    @JavascriptInterface
    fun setSelectionMenu(on: Boolean) {
      selectionMenuOn = on
    }

    @JavascriptInterface
    fun setVolumeKeys(on: Boolean) {
      volumeKeysOn = on
    }

    @JavascriptInterface
    fun get(): String = insetsJson

    @JavascriptInterface
    fun setBarsDark(dark: Boolean) {
      runOnUiThread { applyBarsDark(dark) }
    }
  }

  // ---- 应用内更新 ----

  private fun updatesDir() = File(cacheDir, "updates")

  /** Android 8+ 需要用户为本应用打开「安装未知应用」 */
  private fun canInstallPackages(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()

  @Suppress("DEPRECATION")
  private fun installedVersionCode(): Long =
    androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(packageManager.getPackageInfo(packageName, 0))

  /** 删掉已经装上 (或比当前旧) 的安装包, 以及一天前的半截下载 */
  @Suppress("DEPRECATION")
  private fun cleanInstalledUpdates() {
    try {
      val files = updatesDir().listFiles() ?: return
      val current = installedVersionCode()
      val dayAgo = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
      for (file in files) {
        val stale = if (file.name.endsWith(".apk")) {
          val info = packageManager.getPackageArchiveInfo(file.path, 0)
          info == null || info.packageName != packageName ||
            androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(info) <= current
        } else {
          file.lastModified() < dayAgo
        }
        if (stale) file.delete()
      }
    } catch (e: Exception) {
      // 清理失败不影响启动
    }
  }

  private inner class UpdaterBridge {
    @JavascriptInterface
    fun canInstall(): Boolean = canInstallPackages()

    /** 打开本应用的「安装未知应用」开关页; 个别系统没有该页时退到应用详情 */
    @JavascriptInterface
    fun openInstallPermission() {
      runOnUiThread {
        val pkg = Uri.parse("package:$packageName")
        try {
          if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) throw ActivityNotFoundException()
          startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, pkg))
        } catch (e: Exception) {
          try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
          } catch (e: Exception) {
            // 没有可用的设置页
          }
        }
      }
    }

    /**
     * 打开系统安装器安装 cacheDir/updates/<name> (只接受校验后的 .apk)。
     * 返回 ok / permission (需先开启安装权限) / missing (文件不在) / error
     */
    @JavascriptInterface
    fun install(name: String): String {
      if (!Regex("^[A-Za-z0-9_+-][A-Za-z0-9._+-]*\\.apk$").matches(name)) return "error"
      val file = File(updatesDir(), name)
      if (!file.isFile) return "missing"
      if (!canInstallPackages()) return "permission"
      return try {
        val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        runOnUiThread {
          try {
            startActivity(intent)
          } catch (e: Exception) {
            // 极少见: 系统没有安装器; 用户可在设置页复制链接用浏览器下载
          }
        }
        "ok"
      } catch (e: Exception) {
        "error"
      }
    }
  }

  // ---- 书摘分享 ----

  private val safeName = Regex("^[^/\\\\:*?\"<>|\\u0000-\\u001f]{1,120}$")

  private fun shareDir(): File = File(cacheDir, "share").apply {
    mkdirs()
    // 只留最近一小时的分享文件
    val hourAgo = System.currentTimeMillis() - 60 * 60 * 1000L
    listFiles()?.forEach { if (it.lastModified() < hourAgo) it.delete() }
  }

  private fun startChooser(intent: Intent, title: String) {
    runOnUiThread {
      try {
        startActivity(Intent.createChooser(intent, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      } catch (e: Exception) {
        // 没有可分享的应用
      }
    }
  }

  private inner class ShareBridge {
    /** PNG 存进相册 Pictures/LightRead; 返回 ok / unsupported (Android 9 及以下需前端改走另存为) / error */
    @JavascriptInterface
    fun saveImage(base64: String, name: String): String {
      if (!safeName.matches(name)) return "error"
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unsupported"
      return try {
        val bytes = Base64.decode(base64, Base64.DEFAULT)
        val values = ContentValues().apply {
          put(MediaStore.Images.Media.DISPLAY_NAME, name)
          put(MediaStore.Images.Media.MIME_TYPE, "image/png")
          put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/LightRead")
          put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val resolver = contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return "error"
        try {
          resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IllegalStateException("no stream")
          values.clear()
          values.put(MediaStore.Images.Media.IS_PENDING, 0)
          resolver.update(uri, values, null, null)
          "ok"
        } catch (e: Exception) {
          resolver.delete(uri, null, null)
          "error"
        }
      } catch (e: Exception) {
        "error"
      }
    }

    /** 把文件 (base64) 交给系统分享面板; mime 如 image/png、text/markdown */
    @JavascriptInterface
    fun shareFile(base64: String, name: String, mime: String, title: String): String {
      if (!safeName.matches(name)) return "error"
      return try {
        val file = File(shareDir(), name)
        file.writeBytes(Base64.decode(base64, Base64.DEFAULT))
        val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND)
          .setType(mime)
          .putExtra(Intent.EXTRA_STREAM, uri)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        intent.clipData = android.content.ClipData.newRawUri(name, uri)
        startChooser(intent, title)
        "ok"
      } catch (e: Exception) {
        "error"
      }
    }

    /** 分享纯文本 (划线、整本笔记) */
    @JavascriptInterface
    fun shareText(text: String, subject: String, title: String): String {
      return try {
        val intent = Intent(Intent.ACTION_SEND)
          .setType("text/plain")
          .putExtra(Intent.EXTRA_TEXT, text)
          .putExtra(Intent.EXTRA_SUBJECT, subject)
        startChooser(intent, title)
        "ok"
      } catch (e: Exception) {
        "error"
      }
    }

    /**
     * 能处理选中文字的已装应用 (谷歌翻译、有道、DeepL 等在系统选字菜单里出现的那些),
     * JSON 数组 [{label, pkg, cls}]; 清单的 <queries> 声明了 PROCESS_TEXT (scripts/patch-android-project.mjs)
     */
    @JavascriptInterface
    fun textApps(): String {
      return try {
        val probe = Intent(Intent.ACTION_PROCESS_TEXT).setType("text/plain")
        val pm = packageManager
        val list = org.json.JSONArray()
        for (info in pm.queryIntentActivities(probe, 0)) {
          val act = info.activityInfo ?: continue
          if (act.packageName == packageName || !act.exported) continue
          list.put(org.json.JSONObject()
            .put("label", info.loadLabel(pm).toString())
            .put("pkg", act.packageName)
            .put("cls", act.name))
        }
        list.toString()
      } catch (e: Exception) {
        "[]"
      }
    }

    /** 把选中文字交给指定应用处理 (只读: 不接收改写结果) */
    @JavascriptInterface
    fun processText(text: String, pkg: String, cls: String): String {
      return try {
        val intent = Intent(Intent.ACTION_PROCESS_TEXT)
          .setType("text/plain")
          .setClassName(pkg, cls)
          .putExtra(Intent.EXTRA_PROCESS_TEXT, text)
          .putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)
        runOnUiThread {
          try { startActivity(intent) } catch (e: Exception) { /* 应用已卸载 */ }
        }
        "ok"
      } catch (e: Exception) {
        "error"
      }
    }
  }
}
