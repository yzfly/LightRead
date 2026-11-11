// LightRead 的 iOS 原生壳, 与 Android 的 MainActivity.kt 对应 (设计见 docs/plans/ios-app.md)。
// 网页经主程序的 `ios_shell` 命令调到这里; 方法名即命令名。
import ObjectiveC
import Photos
import SwiftRs
import Tauri
import UIKit
import WebKit

struct FlagArgs: Decodable {
  let on: Bool
}

struct ImageArgs: Decodable {
  let base64: String
}

struct ShareFileArgs: Decodable {
  let base64: String
  let name: String
}

struct ShareTextArgs: Decodable {
  let text: String
}

struct HapticArgs: Decodable {
  let kind: String?
}

// 被替换进系统类的方法读这几个开关, 只在主线程读写
private var barsHidden = false
private var barsDark = false
private var selectionMenuOn = true

class ShellPlugin: Plugin {
  private weak var webView: WKWebView?
  private var controllerPatched = false
  private var selectionPatched = false

  override func load(webview: WKWebView) {
    webView = webview
    // 整页不跟手回弹 (列表内部的滚动容器不受影响)
    webview.scrollView.bounces = false
    webview.scrollView.alwaysBounceVertical = false
    webview.scrollView.alwaysBounceHorizontal = false
    // 左缘右滑返回: vue-router 的 hash 历史就是 WKWebView 的前进后退栈
    webview.allowsBackForwardNavigationGestures = true
  }

  // MARK: 系统栏

  /// 状态栏图标深浅跟随页面 (深色页面用浅色图标)。
  /// 不能改窗口的 overrideUserInterfaceStyle: 那会连网页的 prefers-color-scheme 一起改掉,
  /// 「外观: 跟随系统」读到的就不再是手机的系统设置, 进过一次夜间阅读后整个应用锁在深色。
  @objc public func setBarsDark(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FlagArgs.self)
    DispatchQueue.main.async {
      barsDark = args.on
      if let controller = self.manager.viewController {
        self.patchController(controller)
        controller.setNeedsStatusBarAppearanceUpdate()
      }
      invoke.resolve()
    }
  }

  /// 沉浸阅读: 隐藏状态栏, 主屏幕指示条自动淡出
  @objc public func setImmersive(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FlagArgs.self)
    DispatchQueue.main.async {
      barsHidden = args.on
      if let controller = self.manager.viewController {
        self.patchController(controller)
        UIView.animate(withDuration: 0.2) {
          controller.setNeedsStatusBarAppearanceUpdate()
        }
        controller.setNeedsUpdateOfHomeIndicatorAutoHidden()
      }
      invoke.resolve()
    }
  }

  @objc public func setKeepScreenOn(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FlagArgs.self)
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = args.on
      invoke.resolve()
    }
  }

  /// 阅读页传 false: 系统的「拷贝 / 查询 / 翻译…」菜单不再和划线工具条叠在一起; 选区与把手不受影响
  @objc public func setSelectionMenu(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(FlagArgs.self)
    DispatchQueue.main.async {
      selectionMenuOn = args.on
      self.patchSelectionMenu()
      invoke.resolve()
    }
  }

  /// 根控制器由 Tauri 创建, 不能改源码: 给这个实例换上一个动态子类 (与 KVO 同样的做法),
  /// 只覆盖三个只读属性, 其余行为不变。
  private func patchController(_ controller: UIViewController) {
    if controllerPatched { return }
    controllerPatched = true
    let base: AnyClass = type(of: controller)
    let name = "LightReadShell_\(NSStringFromClass(base))"
    guard let sub = objc_allocateClassPair(base, name, 0) else { return }
    let hidden: @convention(block) (AnyObject) -> Bool = { _ in barsHidden }
    for selector in [
      #selector(getter: UIViewController.prefersStatusBarHidden),
      #selector(getter: UIViewController.prefersHomeIndicatorAutoHidden),
    ] {
      guard let method = class_getInstanceMethod(UIViewController.self, selector) else { continue }
      class_addMethod(sub, selector, imp_implementationWithBlock(hidden), method_getTypeEncoding(method))
    }
    let style: @convention(block) (AnyObject) -> Int = { _ in
      (barsDark ? UIStatusBarStyle.lightContent : UIStatusBarStyle.darkContent).rawValue
    }
    let styleSelector = #selector(getter: UIViewController.preferredStatusBarStyle)
    if let method = class_getInstanceMethod(UIViewController.self, styleSelector) {
      class_addMethod(sub, styleSelector, imp_implementationWithBlock(style), method_getTypeEncoding(method))
    }
    objc_registerClassPair(sub)
    object_setClass(controller, sub)
  }

  /// 系统菜单的每一项都要先问 WKWebView 的内容视图 canPerformAction; 关闭时全部回答「不行」, 菜单就不出现。
  private func patchSelectionMenu() {
    if selectionPatched { return }
    guard
      let content = webView?.scrollView.subviews.first(where: {
        NSStringFromClass(type(of: $0)).hasPrefix("WKContent")
      })
    else { return }
    let cls: AnyClass = type(of: content)
    let selector = #selector(UIResponder.canPerformAction(_:withSender:))
    guard
      let method = class_getInstanceMethod(cls, selector),
      let implementation = class_getMethodImplementation(cls, selector)
    else { return }
    selectionPatched = true
    typealias Original = @convention(c) (AnyObject, Selector, Selector, AnyObject?) -> Bool
    let original = unsafeBitCast(implementation, to: Original.self)
    let block: @convention(block) (AnyObject, Selector, AnyObject?) -> Bool = { me, action, sender in
      selectionMenuOn ? original(me, selector, action, sender) : false
    }
    class_replaceMethod(cls, selector, imp_implementationWithBlock(block), method_getTypeEncoding(method))
  }

  // MARK: 分享与相册

  /// PNG 存进相册; 只申请「添加」权限。返回 result: ok / denied / error
  @objc public func saveImage(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ImageArgs.self)
    guard let data = Data(base64Encoded: args.base64), let image = UIImage(data: data) else {
      invoke.resolve(["result": "error"])
      return
    }
    PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
      guard status == .authorized || status == .limited else {
        invoke.resolve(["result": "denied"])
        return
      }
      PHPhotoLibrary.shared().performChanges({
        PHAssetChangeRequest.creationRequestForAsset(from: image)
      }) { ok, _ in
        invoke.resolve(["result": ok ? "ok" : "error"])
      }
    }
  }

  /// 系统分享面板 (文件); 返回 result: ok / cancelled / error
  @objc public func shareFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareFileArgs.self)
    guard let data = Data(base64Encoded: args.base64) else {
      invoke.resolve(["result": "error"])
      return
    }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("share", isDirectory: true)
    let name = (args.name as NSString).lastPathComponent
    let file = dir.appendingPathComponent(name.isEmpty ? "LightRead" : name)
    do {
      // 每次分享前清掉上一次的临时文件
      try? FileManager.default.removeItem(at: dir)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      try data.write(to: file)
    } catch {
      invoke.resolve(["result": "error"])
      return
    }
    present([file], invoke)
  }

  @objc public func shareText(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareTextArgs.self)
    present([args.text], invoke)
  }

  private func present(_ items: [Any], _ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let controller = self.manager.viewController else {
        invoke.resolve(["result": "error"])
        return
      }
      let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
      sheet.completionWithItemsHandler = { _, completed, _, error in
        invoke.resolve(["result": error != nil ? "error" : completed ? "ok" : "cancelled"])
      }
      // iPad 上分享面板是气泡, 必须给锚点: 屏幕底部正中
      if let popover = sheet.popoverPresentationController {
        popover.sourceView = controller.view
        popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.maxY - 80, width: 1, height: 1)
        popover.permittedArrowDirections = [.down]
      }
      controller.present(sheet, animated: true)
    }
  }

  // MARK: 触感

  /// kind: select (默认, 最轻) / light / success
  @objc public func haptic(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HapticArgs.self)
    DispatchQueue.main.async {
      switch args.kind {
      case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
      case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
      default: UISelectionFeedbackGenerator().selectionChanged()
      }
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_lightread_shell")
public func initPlugin() -> Plugin {
  return ShellPlugin()
}
