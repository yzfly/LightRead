# iOS 版设计（2026-11-11）

目标：把现有 App（`src/mobile/`）带到 iPhone，做到**好看、稳定、有用**；前提是作者没有 iOS 设备。
状态（2026-11-11）：阶段 1 与阶段 2 的大部分已完成，MacAir 上装了 Xcode 与模拟器，App 已在 iPhone / iPad 模拟器里跑通导入与阅读。
做法与首轮结果见 [iOS 模拟器验收](../testing/ios-simulator.md)。与下文的出入：

- 模拟器验收改在 MacAir 本机做，没有走 GitHub Actions（CI workflow 未建）。
- 原生壳已实现：状态栏深浅、沉浸、常亮、划词菜单、分享、存相册、触感、整页不回弹、左缘返回手势开关；内容进程恢复由 Tauri 运行时自带（终止即重新加载）。
- 「用轻阅打开」已通：文档类型写在 `tauri.ios.conf.json`，系统把文件拷进 `Documents/Inbox`，导入后删除副本。没有声明就地打开，也不再把应用目录暴露给「文件」App（书库在 Application Support，暴露 Documents 没有用）。
- 分发（2026-11-11 用户决定）：暂时没有 Apple 开发者账号，不签名；走方案 B，`npm run ios:ipa` 出未签名 IPA。阶段 3（TestFlight）搁置到有账号。
- 状态栏深浅用根控制器的 `preferredStatusBarStyle`，没有用 3 节表里写的窗口外观覆盖（那会让「外观：跟随系统」失效）。
- 阶段 0 的 WebKit 内核 e2e 未做。

## 1. 结论

- **不重新设计界面**。iOS 与 Android 共用 `src/mobile/` 同一套界面，只做 iOS 该有的系统行为。两套界面意味着两倍的验收量，在没有真机的条件下保证不了稳定。
- **缺的是原生桥，不是界面**。Android 的系统能力都写在 `src-tauri/android/MainActivity.kt`（451 行，4 个 JS 桥），iOS 需要一份对应的 Swift 实现，这是主要工作量。
- **没有设备也能做到大部分验证**：三层自动化（WebKit 内核 → iOS 模拟器 → TestFlight 读者真机）。只有四件事必须真机：锁屏 / 后台听书、大 PDF 内存、滚动手感、从微信 / 文件 App 打开。
- 模拟器之前的工作（第 0、1 阶段）不需要 Apple 开发者账号，也不需要 Mac，可以马上开始。

## 2. 现状

已经为 iOS 准备好的：

| 项 | 状态 |
|---|---|
| 界面 | `vite.platform.ts` 对 `TAURI_ENV_PLATFORM=ios` 已选 App 界面 |
| Rust | 平台分支都写成 `any(android, ios)`：离线语音、CBR 解包、单实例、全局快捷键在 iOS 同样不编入 |
| 打开文件 | `lib.rs` 的 `RunEvent::Opened` 已包含 iOS |
| 构建目标 | `BROWSER_TARGET` 含 `safari15` / `ios15`，后行断言已改写 |
| 视口 | `index.html` 已有 `viewport-fit=cover` |
| 版本 | `tauri.ios.conf.json` 存在，`check-release.mjs` 认识 `ios` 平台 |
| 账号 | `DELETE /v1/me` 已有（App Store 要求可在应用内删除账号） |

还没有的：

- 没有 iOS 工程（`src-tauri/gen/apple` 未生成），从未编译过 iOS 目标。
- 三台 Mac（macair、jiangshumac、edy Mac）只有命令行工具，没有 Xcode 和模拟器。
- 端到端测试只跑 Chromium，没有在 WebKit 内核上跑过 App 界面。
- 前端多处用 `/Android/` 判断平台，iOS 会落进「桌面版」分支（设置页版本标签、应用内安装更新）。

## 3. 原生桥对照

| Android 桥 | 作用 | iOS 做法 |
|---|---|---|
| `LightReadInsets.get` | 旧 WebView 不上报安全区 | 不需要。WKWebView 的 `env(safe-area-inset-*)` 可靠 |
| `setBarsDark` | 状态栏图标深浅跟随主题 | Swift：`preferredStatusBarStyle` |
| `setImmersive` | 阅读时隐藏系统栏 | Swift：隐藏状态栏 + `prefersHomeIndicatorAutoHidden` |
| `setKeepScreenOn` | 自动阅读 / 听书不熄屏 | Swift：`isIdleTimerDisabled` |
| `setSelectionMenu` | 划词时不弹系统菜单，用自己的 | Swift：重写 `buildMenu` / `canPerformAction` 清空系统项 |
| `setVolumeKeys` | 音量键翻页 | **不做**。iOS 没有公开接口，绕过去会被审核拒绝 |
| `LightReadLifecycle.isForeground` | 判断前后台 | `visibilitychange` 在 WKWebView 可靠，前端直接用 |
| `LightReadUpdater.*` | 下载并安装 APK | **不做**。iOS 由 TestFlight / App Store 更新；设置页只显示版本和商店入口 |
| `LightReadShare.saveImage` | 金句卡片存相册 | Swift：`PHPhotoLibrary`（只申请「添加」权限） |
| `shareFile` / `shareText` | 系统分享 | Swift：`UIActivityViewController` |
| `textApps` / `processText` | 用其他应用翻译 | 并入系统分享面板，没有逐个应用列表 |

实现形式：一个 Tauri 移动端插件（Swift），前端 `services/systemBars.ts`、`shareOut.ts` 增加 iOS 分支，对上层接口不变。
Swift 源码与工程补丁入库在 `src-tauri/ios/`，`gen/apple` 与 `gen/android` 一样不入库，由 `scripts/build-ios.mjs` 生成后覆盖并打补丁。

## 4. iOS 专属设计

### 好看

- 左缘右滑返回：阅读页 → 书架，二级设置页 → 上一级。iPhone 没有返回键，这是唯一必须新增的手势；与翻页的轻点分区、横向翻页手势要划清边界（屏幕左缘 20pt 归返回）。
- 底部标签栏、底部面板（`AppModal`）避开主屏幕指示条；顶栏避开灵动岛。
- 整页不要橡皮筋回弹（`overscroll-behavior` + 关闭 WKWebView 的 `bounces`），列表内部保留。
- 键盘弹出时输入框不被遮（搜索、写想法、登录验证码）。
- 轻触反馈只用在三处：长按进入选择、划线完成、翻到章末。
- 状态栏深浅、阅读页沉浸与 Android 行为一致。
- 首版 iPad 也用 App 界面（按现有横竖屏自适应排版）；iPad 专属布局以后再议。

### 稳定

| 风险 | 设计 |
|---|---|
| WKWebView 内容进程被系统回收（大 PDF、wasm 内存），表现为白屏 | Swift 监听 `webViewWebContentProcessDidTerminate`，自动重载并回到原书原位置；写一条诊断日志 |
| wasm 内存上限比 Android 低 | 沿用现有 PDFium 崩溃自愈；模拟器上用大 PDF 样本记录内存峰值，超限的走降级提示 |
| 切后台后 JS 定时器被限速，听书预取断档 | `UIBackgroundModes: audio` + `AVAudioSession` 播放类别；预取窗口在 iOS 加大。**只能真机确认** |
| 锁屏控制 | 阅读页已用 `mediaSession`，iOS 15+ 的 WKWebView 支持；真机确认 |
| 书库占用 iCloud 备份额度 | 数据库和设置进备份，书籍文件目录标记为不备份（账号同步能找回） |
| 设置存在 localStorage | 应用自己的 WKWebView 数据随应用保留；模拟器上验证杀进程、重启、升级后设置不丢 |
| 应用内更新逻辑误触发 | iOS 构建不打包更新下载路径，设置页不出现安装按钮 |

### 有用

- **从别处打开书**：`Info.plist` 声明文档类型（与 `tauri.conf.json` 的 `fileAssociations` 同一清单），微信 / 文件 App / 隔空投送里「用轻阅打开」直接入库。国内用户主要靠这条路拿书，优先级最高。
- **文件 App 里能看到书库**：开 `UIFileSharingEnabled` 与 `LSSupportsOpeningDocumentsInPlace`，用户可用文件 App 或数据线拷书、取备份。
- 导入：系统文档选择器（`tauri-plugin-dialog` 已支持）；不提供「选择文件夹」（与 Android 一致）。
- 多端同步、互传、在线语音、书源、书摘与金句卡片都是共享层，随界面带过来。
- 不提供：离线语音（无预编译库）、CBR、音量键翻页、应用内安装更新。

## 5. 没有设备怎么验

| 层 | 在哪跑 | 能证明什么 | 需要 |
|---|---|---|---|
| 0 现有单测与 `cargo test` | t9 | 共享逻辑 | — |
| 1 WebKit 内核 | t9，Playwright `webkit` + iPhone 机型参数跑 `e2e-mobile` / `e2e-v2` | Safari 内核的 CSS / JS 差异、布局溢出、安全区 | 两个脚本加引擎开关 |
| 2 iOS 模拟器 | GitHub Actions macOS runner（公开仓库免费） | 真的 WKWebView + 真的 Rust 构建：启动、导入、阅读、原生桥、杀进程恢复；iPhone SE / 标准 / Pro Max / iPad 截图矩阵 + 录屏 | 新 workflow，不需要签名和账号 |
| 2b 交互式模拟器（可选） | MacAir 装 Xcode（余 243 GB） | 你可以远程亲眼看、亲手点 | 你同意在 MacAir 装 Xcode（约 15 GB + Apple ID） |
| 3 真机 | TestFlight 发给读者群里用 iPhone 的读者；必要时租云真机几小时 | 后台 / 锁屏听书、大 PDF 内存、滚动手感、从微信打开 | Apple 开发者账号 |

第 1 层不等于 iOS Safari（Linux 上的 WebKit 是同一内核的另一个移植），所以只当过滤网，不当验收。
第 3 层按 `docs/testing/k30-ui-acceptance.md` 改一份 iPhone 清单给读者，问题靠现有的诊断包（导出 zip 发群）回收。
在没有任何真机结果之前，版本一律标「实验版」，与 Android 的口径一致。

## 6. 分发

| 方案 | 费用 | 覆盖 | 说明 |
|---|---|---|---|
| A. TestFlight 公开链接 → App Store（推荐） | 开发者账号 99 美元 / 年 | 所有 iPhone 用户 | 先长期停在 TestFlight 也可以 |
| B. GitHub 放未签名 IPA，用户自签 | 0 | 极少数会折腾的用户，7 天重签 | 可作为 A 之前的过渡，也能给愿意帮忙的读者先用 |

上架 App Store 时要面对的审核点（TestFlight 外部测试也过一次简化审核）：

- 书源页含第三方目录与 Z-Library 外链，有版权条款风险；iOS 构建可能需要收窄为 OPDS / 自建书库 / 公版来源。
- 在线语音走的是非官方的 Edge 端点；审核与长期可用性都有风险，iOS 默认语音可能要换成 API 语音或系统语音。
- 中国大陆区上架需要 ICP 备案号（请以苹果当前要求为准，我没有核实最新条款）。
- 隐私清单 `PrivacyInfo.xcprivacy`、出口合规（仅 HTTPS）、应用内删除账号（已有）。

版本线：与 Android 共用 `app-vX.Y.Z`，版本取 `tauri.ios.conf.json`；iOS 包不放 GitHub Release（方案 B 除外），所以不影响现有两个更新器。包名用 `com.yzfly.lightread`，不带 `.debug`（iOS 没有历史包袱）。

## 7. 阶段

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 0 | `e2e-mobile` / `e2e-v2` 加 WebKit 引擎，修内核差异；前端平台判断补 iOS 分支（版本标签、隐藏应用内安装、分享回退） | 无 |
| 1 | `src-tauri/ios/` + `scripts/build-ios.mjs` + `ios-sim.yml`：CI 上出模拟器包、启动、冒烟、截图矩阵 | 无（推送 workflow 需你同意） |
| 2 | Swift 插件：系统栏 / 沉浸 / 常亮 / 划词菜单 / 分享 / 存相册 / 内容进程恢复；文档类型与文件共享；左缘返回 | 阶段 1 |
| 3 | 签名与 TestFlight（CI 用 App Store Connect API 密钥）；读者真机清单；后台听书与内存专项 | 开发者账号 |
| 4 | 上架：书源与语音的 iOS 取舍、隐私清单、商店素材 | 阶段 3 的真机结果 |

## 8. 需要你定的事

1. 分发走 A（开发者账号 + TestFlight）还是先 B？决定阶段 3 何时能开始。
2. 是否同意在 MacAir 装 Xcode（2b）？不装也能做，只是你看不到可交互的模拟器，只有 CI 截图和录屏。
3. iPad 首版用 App 界面可以吗？
4. 书源与在线语音在 iOS 上是否接受收窄（只影响上架，不影响 TestFlight 之前的工作）？
