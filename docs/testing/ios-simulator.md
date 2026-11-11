# iOS 模拟器验收

没有 iPhone 时的验收办法：在装了 Xcode 的 Mac 上把 App 装进 iOS 模拟器，用遥控通道按元素操作，用 `simctl` 截图。
整体设计与真机才能验证的项目见 [iOS 版设计](../plans/ios-app.md)。

## 环境（一次性）

- Xcode（含 iOS 模拟器运行时：`xcodebuild -downloadPlatform iOS`）、`brew install xcodegen cocoapods`、`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`。
- `xcode-select -p` 仍指向命令行工具也能构建：`scripts/build-ios.mjs` 会把构建指到 `/Applications/Xcode.app`；`simctl` 命令前自己加 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`。
- 首次构建要从 GitHub 拉 Swift 依赖，连不上时给构建命令设 `https_proxy`。
- 模拟器包不需要签名和开发者账号。

当前环境在 MacAir：Xcode 26.6，iOS 26.5 运行时，源码副本 `~/workspace/lightread-ios-build`（从开发机 rsync，不含 `.git`）。

## 构建

```bash
npm ci
npm run ios:sim                                   # 普通模拟器包
npm run ios:sim -- --driver http://127.0.0.1:4599 # 带遥控通道, 只用于验收
npm run ios:sim -- --fresh                        # 改了 tauri.ios.conf.json 后重新生成 gen/apple
```

产物：`src-tauri/gen/apple/build/arm64-sim/LightRead.app`。`gen/apple` 不入库，iOS 专属内容在三处：

| 位置 | 内容 |
|---|---|
| `src-tauri/tauri.ios.conf.json` | 版本、最低系统版本（iOS 15） |
| `src-tauri/Info.ios.plist` | 后台音频、文件 App 可见、相册「添加」权限说明等 |
| `src-tauri/plugins/ios-shell/` | Swift 原生壳：状态栏深浅、沉浸、常亮、划词菜单、分享、存相册、触感 |

## 运行与遥控

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcrun simctl list devices available            # 选一台, 记下 UDID
xcrun simctl boot <UDID> && xcrun simctl bootstatus <UDID>
node scripts/ios-sim/driver-server.mjs 4599 <样书目录> &
xcrun simctl install <UDID> src-tauri/gen/apple/build/arm64-sim/LightRead.app
xcrun simctl launch <UDID> com.yzfly.lightread
curl -X POST --data-binary 'return h.summary()' http://127.0.0.1:4599/run
xcrun simctl io <UDID> screenshot shot.png
```

`/run` 的正文是一段脚本，在应用页面里执行，返回值以 JSON 回来。可用的 `h`：

| 方法 | 作用 |
|---|---|
| `h.summary()` | 路由、视口、主题、可见按钮文字 |
| `h.click(选择器或可见文字)` | 等元素出现后点击 |
| `h.tap(x, y)` | 指针事件轻点（阅读页轻点分区用这个） |
| `h.importBook(文件名)` | 从样书目录取文件，经书架的文件选择框导入 |
| `h.wait(探测函数, 超时)` / `h.sleep(ms)` / `h.q(选择器)` / `h.byText(文字)` | 等待与查找 |

原生壳可以直接调：`window.__TAURI_INTERNALS__.invoke('ios_shell', { command: 'setImmersive', args: { on: true } })`。
同一个遥控端同时只连一台模拟器（两台都在取任务时结果会串）。分享面板等原生界面只能截图看，关不掉时重启应用。

遥控通道能执行任意脚本：只有设了 `LIGHTREAD_E2E_DRIVER` 的构建才带（`vite.config.ts` 的 `__E2E_DRIVER__`），`scripts/check-release.mjs` 发版时拒绝这个环境变量。

## 2026-11-11 首轮结果

iPhone 17 与 iPad Air 11 英寸模拟器（iOS 26.5），样书：《The Republic》EPUB、《紅樓夢》EPUB（Project Gutenberg）、arXiv 论文 PDF。

| 项 | 结果 |
|---|---|
| 启动、书架、底部标签栏、安全区 | 通过 |
| 导入 EPUB / PDF（原生分块写入、SQLite、封面） | 通过 |
| EPUB 阅读：竖屏滚动、工具栏、目录、排版面板、进度恢复 | 通过 |
| PDF 重排与原版（MuPDF wasm） | 通过 |
| 夜间正文 + 状态栏图标变浅，退出后恢复 | 通过（修了两个问题，见下） |
| 沉浸：隐藏状态栏 | 通过（直接调原生壳） |
| 系统分享面板 | 通过（直接调原生壳） |
| 重装后藏书与进度保留 | 通过 |
| 设置页显示「iOS 版」，不提示 APK 更新 | 通过 |
| iPad 布局（平板图标栏） | 通过 |

顺带发现并修掉的问题（前两项 Android 也受影响）：

1. App 的夜间主题下，自带 `body { color: black }` 的书（Project Gutenberg）是黑底黑字。桌面早已修过，App 的 `readerTheme.ts` 漏了。
2. 应用浅色 + 正文夜间时，书页底色是纯黑，与上下安全区颜色接不上（iframe 与宿主 `color-scheme` 不一致时浏览器垫的不透明底）。
3. 网络权限 `http://**` 不包含带端口的地址，自建书库用 `http://192.168.x.x:8080` 这类地址会被原生层拒绝；已补 `http://*:*`、`https://*:*`。

还没做的：

- 经界面触发的存相册、划词菜单抑制、左缘右滑返回（手势需要触摸输入，遥控通道模拟不了）。
- 听书（模拟器里无法判断后台与锁屏行为）、同步、书源、互传。
- 内容进程被系统回收后的自动恢复。
- 桌面与 Android 的 Rust 编译回归：当天 t9 连不上，未跑 `cargo test`。
