# LightRead 轻阅

开源、本地优先的电子书 / 论文阅读器。桌面 (Tauri 2) + 网页 PWA + Android 实验版。
产品定位与已定决策见 `docs/产品设计.md`，论文阅读链路见 `docs/paper-reading.md`。

## 分支与版本（2026-10-25 用户确认：桌面与 App 分开发版）

- **`main` 是唯一开发主干**，桌面与 App 共用。共享层（存储、同步、阅读引擎、全部 Rust）一处修改两端生效。App 专属界面在 `src/mobile/`，由构建平台选择（`vite.platform.ts`），不按窗口宽度切换产品；桌面借鉴 App 设计时改桌面自己的文件，不直接引用 `src/mobile/`（见 `src/mobile/README.md`）。PDF 重排等 App 功能的入口留在 `src/mobile/`，引擎可放共享服务。
- 只有在给已发布版本打补丁、而 `main` 已有未发布改动时，才从对应 tag 拉 `release/desktop-X.Y` 或 `release/app-X.Y`；修复先进 `main` 再 cherry-pick。
- 只读历史分支：`archive/main-1.x`（1.x 桌面旧主干）、`release/1.20.0`（1.x 全平台最终版）。原 `Dev` 已并入 `main`。
- 两条版本线各自递增，互不等待：

| | tag | 版本来源 | GitHub Release |
|---|---|---|---|
| 桌面（Windows / macOS / Linux，网页） | `vX.Y.Z` | `package.json`、`package-lock.json`（顶层与根包）、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（lightread 包） | 设为 latest，**不含 APK** |
| App（Android / iOS） | `app-vX.Y.Z` | `src-tauri/tauri.android.conf.json`、`src-tauri/tauri.ios.conf.json` | `latest=false` |

- 为什么必须这样分：已安装的桌面更新器只读 GitHub latest（`vX.Y.Z`）；已安装的 App 更新器取版本最高、带 `_android_arm64.apk` 与 `SHA256SUMS` 的 `vX.Y.Z` / `app-vX.Y.Z`。桌面 Release 混入 APK 会被推给 App 用户，App Release 设为 latest 会被推给桌面用户。`scripts/check-release.mjs` 与 `scripts/test-platform-boundary.mjs` 强制桌面只用 `v`、App 只用 `app-v`。v2.2.0–v2.2.5 是当时统一发版的全平台 Release；`app-v2.0.0` 的 tag 与资产保留（该 APK 只识别 `app-v2.x`）。
- Release 标题只用版本号。App 默认在线语音；K30 已将旧离线选择改为在线，测试恢复设置时不要改回离线。

## K30 真机验收（2026-10-18 用户要求）

完整验收先设计测试计划与能力清单，再自顶向下逐项点击每个栏目、窗口、功能和按钮。阅读样本用《理想国》和 K30 已有书籍，不以短合成文本代替长文验收；不为节省耗时省略检查。逐项记录实际结果、证据、缺陷和受阻条件，遵循 [K30 验收约定](docs/testing/k30-ui-acceptance.md)。

## 技术栈

- 前端: Vue 3 `<script setup>` + TypeScript + Vite 8 + Pinia + vue-router (hash 路由，兼容 Tauri file 协议)
- 桌面壳: Tauri 2 (Rust, `src-tauri/`)；网页版部署到 Cloudflare (`wrangler.jsonc`, `relay/`)
- 阅读引擎: foliate-js (EPUB/MOBI/AZW3/FB2/CBZ + 转成内存 EPUB 的 TXT/HTML/MD)，PDF 走 MuPDF / PDFium wasm，DjVu 走 `src/vendor/djvu.js`
- 存储: `src/storage/` 的 `LibraryStorage` 抽象 — 桌面 `tauri.ts` (文件 + SQLite)，网页 `dexie.ts` (IndexedDB)
- 无 UI 组件库、无 Tailwind：样式全部是手写 CSS + `src/styles/main.css` 里的设计令牌

## 构建机（2026-10-22 / 10-23 用户要求）

编译、测试、打包（前端构建、Rust 编译与原生测试、e2e、Android APK）一律放 **t9**（`ssh t9`，本机隧道 127.0.0.1:2203，用户 jiangshu），本机只做编辑、轻量检查和 git。
- 非交互 SSH 先 `source ~/.cargo/env`（或 `bash -lc`）。源码同步到 `~/tokenssh-build/runs/<任务名>/`，不要同步 `node_modules`、`target`、密钥或无关草稿；Rust 缓存用 `~/tokenssh-build/cache/lightread-cargo-target`。
- 重任务串行：`flock /tmp/heavy.lock nice -n 10 …`。桌面前端构建设 `TAURI_ENV_PLATFORM=linux`；无显示器的桌面启动与拖放验证用 `xvfb-run`（GTK 3、WebKitGTK 4.1、Xvfb 已装）。
- Linux 产物不能代替 macOS / Windows 构建，这些仍由 CI 出包。

## 常用命令

```bash
npm run dev                 # vite 开发服务器, 固定 5173 端口 (strictPort)
npm run build               # vue-tsc -b && vite build
npm run android:build       # 本机打 Android APK (固定 CARGO_PROFILE_DEV_DEBUG=0 + clean + 固定签名, 打完校验无调试符号); 不要手敲 tauri android build
npx vue-tsc -b              # 只做类型检查
npm run test:paper-agent    # 论文 Agent 前端契约 (node --test)
npm run test:paper-context / test:keyboard-shortcuts / test:archive
npm run test:sync-merge / test:sync-engine / test:sync-account / test:sync-settings   # 多端同步: 合并纯函数 + 引擎 + 账号 + 设置同步 (假存储/假远端)
npm run test:sync-large-files   # 同步大文件: 分块 SHA-256 / 原生算指纹不读文件 / 暂存文件下载与校验
npm run test:reading-log    # 阅读记录: 计时规则 + 每日统计 + 多端同步往返
npm run test:compat / test:tts   # 旧 WebView 兼容 (构建目标/polyfill/CSS 回退); 离线听书调度
npm run test:reader-pages / test:listen-eta   # 重排书页码 (实测+推算/双栏/跳页往返); 听书剩余时间 (语速学习/人话时长)
npm run test:cloud-tts       # API 语音 (MiniMax / 豆包): 音色目录 / 设置到请求的映射 / 错误分类; 原生请求见 cargo test cloud_tts
npm run test:diagnostics     # 诊断日志: 脱敏 / 单行格式 / 环形缓冲 / 反馈链接 + wasm 崩溃判定
E2E_BASE=http://localhost:<端口> npm run e2e:pdf-crash   # PDF 引擎崩溃自愈 (注入 trap): 退化不抛错 / 新实例恢复 / MuPDF 回退 PDFium / 诊断包; 需先起 vite dev
npm run test:read-aloud      # 听书: 句子游标断句 + 播放管线 (分块/预取/无缝拼接/回退, 假时钟) + 音色目录
npm run test:reading-modes   # 阅读模式: 打字机出字节奏 / 断句 / 按行分组 (纯函数)
npm run test:reading-focus   # 阅读焦点: 舒适区 25%–65% / 焦点线 38% / 长句 / 手动滚动后暂停跟随 (听书跟随与跳转落点, 纯函数)
npm run test:reader-tap-zone # 轻点分区: 横屏左·中·右 / 竖屏上·中·下 / 自动阅读时无翻页区 (纯函数)
npm run test:display-title   # 手机书架短书名 / 短作者: 只去末尾长营销括注, 作者取分号前第一段 (src/services/displayTitle.ts)
npm run test:about-links      # 关于页全平台下载 (桌面 v / App app-v 各取最新, 镜像只认已校验版本) + 读者群二维码过期 (src/services/aboutLinks.ts)
npm run check:style-tokens    # 样式档位棘轮: 裸 px 字号 / 圆角 / 阴影 / 非 400·500·600 字重只许减少; 替换一批后 node scripts/check-style-tokens.mjs --update
node scripts/publish-community.mjs <二维码.png> --expires YYYY-MM-DD [--wechat ID]   # 换关于页微信群码 (7 天过期, 不打包): 传 R2 lightread-assets/community/v1/ 并回读校验; 先裁到只剩二维码。过期后应用显示作者微信 1796060717 (加好友拉群, --wechat 可远程改)
npm run test:cover-repair     # 损坏封面: 空文件 / 缺失 / 非图片回退文字封面, 从书籍文件重新生成写回, 取不到清标记 (src/services/coverRepair.ts)
npm run test:zh-segment      # 仿生阅读中文分词: 词表切分 / 歧义不上色 / ICU 回退 / 交替规则 / 速度 (<15ms/万字)
npm run test:key-words       # 点睛重点词: 本书新词发现 / 自信息 + 关键度 + 聚集度打分 / 密度与间隔 / AI 词定位与回退 (设计见 docs/research/entropy-keyword-highlighting.md、llm-keyword-selection.md)
npm run test:terminology     # 术语来源完整性 / 22 类路由 / 原文跨度 / 边界与预算
npm run test:concept-recognition # 生产完整概念边界 / 智能碎片扩展 / 失败回退
npm run test:auto-scroll     # 多刷新率速度 / 卡帧与调速 / 亚像素累计
npm run test:translate       # 划词翻译 (目标语言 / 校验 / relay /v1/translate 按账号每日 100 次 / 账号校验缓存) + 正文简繁转换 (OpenCC 等长替换, CFI 不变)
E2E_BASE=http://localhost:<端口> npm run e2e:translate   # 选中本段 → 翻译 (未登录引导 / 账号额度 / 超额) → 简繁往返; E2E_MOBILE=1 测 App 并校验顶栏与浮动听书胶囊按钮一致 (components/ListenCapsule.vue)
npm run test:stealth         # 摸鱼模式 (桌面): 老板键录制 / 校验 / 显示, 半透明底色, 传给原生层的选项, 透明窗口配置 (App 窗口保持不透明); 原生窗口命令见 cargo test stealth (src-tauri/src/stealth.rs)
E2E_BASE=http://localhost:<端口> npm run e2e:stealth   # 模拟桌面 IPC: 网页版无入口 → 从「阅读模式」面板进入 (面板内可调浓淡与隐蔽开关) → 只剩正文 + 半透明 → 透明度 / 伪装即时生效 → 老板键事件 → Esc 退出 → 打开图书自动进入 → PDF 阅读页 (入口在「视图」, 页外底色透明, 整页按浓淡淡化) → 设置页录制老板键; 两个阅读页共用 composables/useStealth + components/StealthStrip
E2E_BASE=http://localhost:<端口> npm run e2e:window-chrome   # Windows 自绘窗口 (与 macOS 对齐: 无系统标题栏 / 无深色细边框 / 圆角; 非阅读页为 2026-11-08 用户选定的原型 B「侧栏到顶」, docs/prototypes/windows-shell): 侧栏到顶 + 按钮浮在右上且不压页面标题行, 顶行空白拖动 / 双击最大化, 标题栏按钮 → 窗口命令, 阅读页保留标题条, 最大化去圆角, 摸鱼收起; 原生侧 cargo test window_chrome (src-tauri/src/window_chrome.rs, tauri.windows.conf.json)
npm run audit:keywords       # 离线复现词边界、同形词跨语境和未来新词影响; 不是准确率评测
node scripts/build-terminology.mjs   # 重建开放候选词库与覆盖报告; 方案见 docs/research/keyword-optimization.md
node scripts/build-zh-lexicon.mjs   # 重新生成中文词表 src/data/zh-lexicon.txt + 回退合并表 zhMergeWords.ts (下载 jieba / DeepSeek-R1 词表到 ~/.cache, 校验 SHA-256)
npm run test:book-sources    # 公共书源: 查询归一 / 哲学文库·研辞问典本地索引搜索 / 教材分卷合并与排序 / IA·Open Library·GitHub 相关度
node scripts/build-philosophy-index.mjs   # 重新生成哲学文库离线索引 src/data/philosophy-index.json (限速抓目录页, 约 5 分钟)
node scripts/build-wendian-index.mjs      # 重新生成研辞问典离线书目 src/data/wendian-index.json (sitemap + 分类列表页, ≤1 次/秒, 约 17 分钟; 不碰站内搜索)
npm run test:notes-export / test:quote-card   # 书摘导出: MD / 微信读书纯文本 / JSON / Readwise CSV; 金句卡片纯函数 (句读分行与均衡 / 禁则 / 配色 / 短书名), 绘制见 src/services/quoteCard.ts
E2E_BASE=http://127.0.0.1:<端口> node scripts/e2e-notes-export.mjs   # 书摘端到端 (划线 → 面板 → 复制全部 → 导出 → 15 套卡片出图), 需先起 vite dev; E2E_MOBILE=1 且 LIGHTREAD_UI=mobile 测 App 界面
npm run test:opds-library / test:library-upload   # 自建书库: 连接信息解析·搜索发现·EPUB 优先; 上传协议
npm run test:native-drop    # 桌面原生拖放事件与批次队列; e2e:native-drop 连接 Vite dev, 模拟 IPC 验证导入全流程
cargo test --manifest-path src-tauri/Cargo.toml library_import --lib  # Rust 文件/文件夹扫描与复制暂存 (在 t9 执行)
npm run test:folder-pick / e2e:folder-pick   # 选择文件夹导入 / 上传: 递归找书 + 按格式推荐度去重
npm run e2e:continuous-scroll   # 跨章连续滚动: 逐帧触摸 + 惯性跨章, 无回跳 / 预载 / 插入上方不跳 (设计见 docs/continuous-scroll.md)
npm run test:plain-text      # 通用纯文本: 源码/配置/日志/无扩展名文件识别 · 内容嗅探 · 代码视图 (行号/分块), 按 txt 入库 (src/services/plainText.ts)
npm run test:pdf-reflow / e2e:pdf-reflow # App PDF 重排契约／双形态浏览器测试（App 预览加 E2E_MOBILE=1）
npm run test:convert-epub    # 格式转换: MOBI/AZW3/FB2/TXT → EPUB 3 (OPF/nav/资源改写)
npm run test:transfer / test:qr   # 互传: 三种通道 (账号 / WebDAV / 取件码) 纯逻辑; 无依赖二维码编码
npm run test:booklists / e2e:booklists   # 书单: 待找匹配·自动归入·分享导入·推荐书单校验; 浏览→找书→加入→分享→导入 (node scripts/build-booklists.mjs 用 Wikidata 重建奖项书单)
npm run e2e:transfer         # 互传端到端: 本地 wrangler sync-server + 内嵌 WebDAV, 预览默认 4186 (E2E_BASE 可改)
npm run e2e:convert-epub / e2e:library-upload / e2e:book-sources   # 对应功能的浏览器端到端 (需先 build + preview)
(cd sync-server && node --test test/api.test.mjs)                  # 账号后端契约 (wrangler 本地运行时)
cargo test --manifest-path src-tauri/Cargo.toml agent   # 论文 Agent 原生契约
cargo test --manifest-path src-tauri/Cargo.toml ipc_contract   # 书库原生命令 IPC 契约: 藏书包原生导出/导入、换书库文件夹、改名 (前端实际 JSON 参数)
npm run test:zh-segment-wasm   # 中文分词核心 Rust/wasm 与 JS 逐位一致 + 整条重点词管线不变; 改 wasm/zh-segment 后先 scripts/build-zh-segment-wasm.sh
node scripts/gen-epub-meta-golden.mjs   # 升级 foliate-js / 改导入取元数据规则后: 重生成 Rust 原生 EPUB 元数据的期望, 再跑 cargo test epub_meta
node scripts/gen-txt-epub-golden.mjs   # 改了 TXT 分章 / 段落规则后: 用前端 convertToEpub 重生成 Rust 原生 TXT→EPUB 的逐字节期望 (需 vite 开发服务器 5180), 再跑 cargo test txt_epub
scripts/build-ui-font.sh   # 重新生成桌面展示字体子集 (霞鹜文楷, 只含界面词典用到的字); 改标题类文案后重跑
npm run tauri dev|build     # 桌面 (需要 Rust 工具链)

# 端到端冒烟 (Playwright): 先构建并起预览, 再跑脚本 (脚本写死 http://localhost:4173)
npm run build && npx vite preview --port 4173 --strictPort &
npm run e2e                 # scripts/e2e-smoke.mjs, ~35 步: 导入 → 书单 → 阅读器 → PDF → 持久化
npm run e2e:mobile          # scripts/e2e-mobile.mjs: 15 款手机竖屏 × 主要页面, 查横向溢出/触控目标/安全区遮挡, 报告 /tmp/lightread-mobile (STRICT=1 有 error 即失败)
npm run e2e:sync            # 内嵌 WebDAV, 两个浏览器上下文互相同步 (协议见 docs/sync.md)
npm run e2e:account         # 本地 wrangler 起 sync-server, 两台设备走邮箱验证码登录并同步
BIG_TXT=… PDF_FIXTURE=… node scripts/perf.mjs   # 性能基准 (打开/翻页/PDF + 长任务), 账本见 docs/perf-ledger.md
```

- 每次 `vite build` 后要**重启** `vite preview`（Cloudflare 插件会缓存资源清单，否则页面空白报 MIME 错误）。
- e2e 首次运行需要 `npx playwright install chromium`。

## 目录速览

```
src/
  App.vue              应用壳: 侧栏 / 平板图标栏 / 手机底部标签栏, 更新按钮
  views/               LibraryView(藏书+论文共用) ReaderView(foliate) PaperReaderView(PDF, 7k 行) DjvuReaderView CatalogView SettingsView
  components/          BookCard TocList ToastHost PaperAgentSidebar BabeldocTaskStatus
  stores/              settings.ts (localStorage, 带 SETTINGS_VERSION 迁移) library.ts
  services/            纯函数 / 平台适配: importer, opds, arxiv, tts, ai, paperAgent*, backup, appearance …
  services/sync/       多端同步: types(契约) merge(纯函数) engine(编排) webdavRemote baseline(IndexedDB lightread-sync)
  i18n/                zh.ts (默认, 缺失回退来源) en.ts; t(key, params) 纯函数, key 为 'area.name' 字符串
  styles/main.css      设计令牌 + 全局组件类 (.btn .input .card .tag .segmented .modal .toast .empty .skeleton)
scripts/               e2e-smoke.mjs e2e-full.mjs perf.mjs 各类 node --test 契约测试
src-tauri/src/         Rust 命令: agent/ babeldoc calibre edge_tts local_tts fonts
sync-server/           轻阅账号后端 (Cloudflare Worker + D1 + R2, sync.jiangshu.ai), API 见 docs/account-api.md
```

## 约定

- **能用 Rust 就用 Rust（2026-10-22 用户要求）**：文件读写、哈希、下载、格式解析等重活优先写成 `src-tauri/src/` 的原生命令，提升质量与性能；前端只做界面和编排。安卓 WebView 的 IPC 会把字节数组序列化成 JSON 数字数组，大文件不要整本经 `plugin-fs` 进出 JS（导入走 `library_file_write_chunk`，同步走 `library_file_download` / `library_file_sha256`，见 issue #14）。网页版没有原生层，保留 JS 实现作回退。哪些已原生、哪些留在 JS 及实测依据见 `docs/rust-native-audit.md`，新增候选先对照它。
- **诊断日志（2026-11-06 用户要求）**：桌面与 App 写本机滚动日志 (`src-tauri/src/diagnostics.rs`，`lightread.log` 1MB 一份、留 4 份历史)，前端错误经 `services/diagnostics.ts` 写入，网页版只留内存缓冲。写入和导出各脱敏一次（规则在 `diagnosticsCore.ts`，加规则同时加测试）。**不自动上传**（2026-11-06 用户确认一键上传先不做），反馈主入口是读者微信群：入口在关于页读者群模块（`AboutLinks` → `DiagnosticsPanel`），用户导出 zip 后发到群里，GitHub 只作次要入口。新功能的失败路径用 `logEvent` 记录；不记录书籍正文、划线和设置内容。
- **wasm 实例崩溃后不能复用（2026-11-06）**：abort / trap 后实例状态不可信，之后任何文件都只会报 `memory access out of bounds`。PDFium 的处理在 `services/pdfium.ts`（`retireModule` + 打开重试一次），崩溃判定在 `services/wasmCrash.ts`；清理调用（`destroy` / `close`）放在 `finally` 里时必须自带 try，否则会盖掉回退路径。
- **样式档位（2026-10-26 用户确认收敛方案，见 `docs/design/style-convergence.md`）**：新写或改动的界面只用 `--fs-caption/small/body/subtitle/title/display`、`--fw-regular/medium/semibold`、`--radius-xs/sm/(默认)/lg/pill`、`--space-*`、`--shadow-1/2/3`，不写新的裸 px；`npm run check:style-tokens` 在发版 preflight 里只许裸值减少。桌面藏书页已按用户选定的「书桌」原型（B）改版：继续阅读卡含今日 / 本周、书单像标签页、书卡只有封面 + 短书名 + 「进度 · 作者」，操作收进「⋯」菜单（菜单项保留 `.action.*` 类名并始终在 DOM 里）；其余桌面页面按方案逐页替换。
- **样式只用语义令牌**（`--bg --card --surface-2 --text --text-2 --text-3 --border --brand --brand-light --danger --success …`），不要在组件里写裸色值。深色模式通过 `<html data-theme="dark">` 重定义令牌实现，由 `services/appearance.ts` 依据 `settings.appearance` (system/light/dark) 写入。
- 全局类 `.segmented` 是设置页等的分段控件；阅读器工具栏各自有 scoped 的 `.seg`，不要合并。
- 图标一律内联 SVG（`aria-hidden="true"`），不用 emoji 当图标；图标按钮必须有 `aria-label`/`title`。
- 触屏设备不依赖 hover：`@media (hover: none)` 下提供可点的替代（如 BookCard 的「更多」按钮）。
- 所有用户可见文案走 `t()`，中英两个字典同时加 key，放在对应分区（`// ---- 藏书 ----` 等）。
- UI / UX 需求先从全局检索同类入口，优先统一控件与交互；不只修反馈截图里的单点。应用内选择和确认使用 `AppSelect` / `AppModal` / `askConfirm`，不新增原生 `<select>` 或 `alert` / `confirm` / `prompt`。文件选择、权限和安装器属于系统能力。
- 全局排查不等于扩大改版范围。替换弹窗时保留所在页面原有布局与触发控件尺寸；未明确要求改版的页面不得顺带重排。藏书页手机端 (≤720px) 已按 2026-10-17 用户确认的原型改版：标题 + 今日 + 圆形「＋」/ 吸顶搜索 / 继续阅读卡 / 列表标题 (范围·排序·选择) / `BookCard compact` (封面只留进度条, 「⋯」在作者行, 长按进入选择) / 选择模式底部 4 项操作栏；添加、书卡操作、批量更多都走 `AppModal` 底部面板。论文 / 书源 / 阅读记录 / 设置的手机端 (≤720px) 按 2026-10-17 用户确认的原型改版：论文页为状态 + 标签筛选与列表行 (`services/paperState.ts`)；书源页按 2026-10-18 已确认原型修正为搜索范围选择窗口、公共书源／私人书库／个人书单分组，社区目录折叠；推荐书单按 2026-10-18 用户要求归入藏书 → 书单，放在个人书单下方，不再放在书源页；藏书的「书单」为页内列表，管理独立打开；设置页为账号卡 + 分组列表，二级页复用原分区并由 `?page=` 驱动。桌面布局保持原样，不要把手机改版带到桌面（桌面藏书页 2026-10-26 起按用户选定的「书桌」原型改版，见上方「样式档位」；那是桌面自己的设计，不是手机改版）。
- 手机文案按实际宽度检查换行；超过两行的界面说明逐项审阅，优先精简或按需展开。保留关键风险信息，不截断书籍正文、用户内容和必要错误详情。
- 横竖屏排版由 `services/adaptiveLayout.ts` + `readingViewport.ts` 统一计算，只读 `settings.readerPrefs` / `pdfPrefs` 生效值，不把自动值回写到保存设置。用户输入通过 `setReaderPreference` / `setPdfPreference` 标记显式选择（包括与默认值相同的选择）；手动项优先，旋转和窗口缩放不能覆盖。`layoutOverrides` 与偏好同步，旧存档按自定义值和修改记录迁移。
- 新增设置项：在 `SettingsState` + `defaults` 里加字段即可（load 时自动 merge）；改历史默认值才需递增 `SETTINGS_VERSION` 并写迁移。
- Vue 模板里 `v-for` 变量不要用 `t`（会遮蔽 i18n 函数）。
- 组件样式用 `<style scoped>`；需要覆盖主题的选择器写成 `:root[data-theme='dark'] .x`。

## 边界 / 不要做

- **e2e 依赖的选择器别改语义**：`getByRole('button', { name })`（分段控件按钮不要改成 `role="radio"`），`button[title="目录"]` 等 title 文案，`.book-card` `.booklist-action` `.booklist-chip` `.sidebar-update`（收起 ≤42px、悬停 ≥108px）、`text=书架还是空的` / `这个书单还是空的` 等文案 key。改动后跑一遍 `npm run e2e`。
- `PaperReaderView.vue` 仍有少量硬编码颜色（约 20 处十六进制色值，分布在全屏背景、页面底色、翻译对照与 BabelDOC 面板），深色主题下未完全适配；改这些面板前先看对应样式。
- Z-Library 等需要登录/验证的来源使用外部浏览器；优先接入免登录的公开搜索与下载（2026-10-03 用户要求）。不支持 KFX（见产品设计文档），不引入组件库 / Tailwind。
- 阅读正文主题 (`settings.reader.theme`) 与应用外观 (`settings.appearance`) 是两个设置项，不要把显式选择的正文主题绑到外观上；默认值 `auto` 例外，它经 `resolveReaderTheme()` 跟随外观在浅色/夜间间切换。
- 不要提交 `.env*`、`.corpus`、`dist`、`src-tauri/target`。

## 官网与固定下载链接（2026-11-01 用户要求）

- 官网 https://code.jiangshu.ai/LightRead/ 是对外唯一入口：GitHub 仓库 homepage、README、应用「关于」页与手册的「在网页上看」都指向它；以后 App 的说明页、帮助链接一律跳官网（地址集中在 `src/services/siteLinks.ts`）。页面同时写给人和 AI 看：JSON-LD、`llms.txt` / `llms-full.txt`、每章 `.md` 原文、sitemap。
- 源码 `site/index.html`（手写首页，读书气质 + 磨砂玻璃）+ `scripts/build-site.mjs`（把 `docs/manual` 等渲染成 `manual/*.html`、`docs/*.html`，输出 `site-dist/`）。`.github/workflows/pages.yml` 在 site / 手册 / 版本文件改动后发布到 GitHub Pages。新增站内文档要同时改 `build-site.mjs` 的 `PAGES` 与 `siteLinks.ts`（`npm run test:site-links` 校验）。
- 固定下载链接 `https://code.jiangshu.ai/LightRead/download/<windows|mac|mac-intel|linux|linux-deb|linux-rpm|android>` 始终 302 到最新版（`?mirror=gitcode` 走镜像，`/download/latest.json` 给机器读），由 Cloudflare Worker `download-worker/`（路由 `code.jiangshu.ai/LightRead/download*`）提供，版本挑选复用 `src/services/aboutLinks.ts`，发版后无需改动。部署：`cd download-worker && CLOUDFLARE_API_TOKEN=$(cat ~/.config/tokenssh-ai/cloudflare-workers-token) npx wrangler deploy -c wrangler.jsonc`。

## 账号后端部署

- `cd sync-server && npx wrangler deploy -c wrangler.jsonc`（必须带 `-c`，否则会撞上根目录构建留下的 `.wrangler/deploy/config.json`）。用 `~/.config/tokenssh-ai/cloudflare-workers-token` 作 `CLOUDFLARE_API_TOKEN` 即可部署；它没有 D1 权限，改表结构要走 Cloudflare MCP 的 D1 query API。
- `DEV_EXPOSE_CODE` 只用于本地测试，**生产绝不能设**（否则任何人都能拿到任意邮箱的验证码）。

## 发版流程

通用规则：
- 提交信息用 `release: vX.Y.Z`（桌面）或 `release: app-vX.Y.Z`（App），正文写用户可见变化、修复、验证与已知限制，作为 Release 说明。
- 推送用 yzfly 账号（`gh auth switch -u yzfly`）。获得发版授权后才创建并推送 annotated tag；只整理发版规范的任务不推送、不发布。
- 仓库变量 `RELEASE_BUILD_MODE=manual`：推 tag 不自动构建，由下面的 `gh workflow run` 显式触发。
- 任一环节失败都保留草稿，修复后用同一 tag 重跑；workflow 只续建草稿，拒绝覆盖已公开版本，也不移动已有 tag。审核脚本取自本次 workflow 的固定 SHA，旧 tag 不必自带新版脚本。

### 桌面 `vX.Y.Z`

1. 修改上表的桌面版本文件，执行 `node scripts/check-release.mjs --self-test` 和 `node scripts/check-release.mjs --platform desktop --tag vX.Y.Z`。
2. 在 t9 跑相关单测、`npm run build`、`npm run e2e` 及改动涉及的 e2e；Rust 变更跑对应 `cargo test`。
3. `git tag -a vX.Y.Z -m "vX.Y.Z"`、`git push origin main vX.Y.Z`，再 `gh workflow run release.yml --ref main -f tag=vX.Y.Z`。`.github/workflows/release.yml`：preflight 校验版本与回归测试并建草稿 → macOS arm64 / x64、Windows NSIS、Linux AppImage / deb 构建上传，Rust 1.87 最低版本检查 → publish 核对安装包齐全且**不含 APK**，生成并回验 `SHA256SUMS`，公开为 latest → GitCode 镜像。
4. 公开后核对下载链接、版本说明、`SHA256SUMS` 与桌面应用内更新。

### App `app-vX.Y.Z`

1. 修改 `tauri.android.conf.json` / `tauri.ios.conf.json` 的版本，执行 `node scripts/check-release.mjs --platform android --tag app-vX.Y.Z`。
2. 在 t9 **只用 `npm run android:build`** 打包（`scripts/build-android.mjs`：固定 `CARGO_PROFILE_DEV_DEBUG=0`、先 `:app:clean`、要求固定签名；手敲 `tauri android build` 会带完整 DWARF，APK 从约 94MB 涨到 280MB+）。对产物执行 `node scripts/check-release.mjs --platform android --tag app-vX.Y.Z --apk LightRead_app-vX.Y.Z_android_arm64.apk --cert <固定证书SHA256>`（`aapt` / `apksigner` 在 PATH 或经 `AAPT` / `APKSIGNER` 指定），校验包名、versionName、versionCode、仅 arm64-v8a、minSdk 24、targetSdk 36、签名证书、ZIP 布局与 `.so` 无 `.debug_*` 段，并生成 `.apk.json` 与 `.apk.sha256`。API 基线升级必须显式审查并更新检查脚本。
3. 手写 `LightRead_app-vX.Y.Z_android_arm64.apk.build.json`（`tag`、`commit`、`sha256`）并生成 `SHA256SUMS`；推送 tag，建 `app-vX.Y.Z` 草稿，**只**上传这五个文件（APK、`.apk.json`、`.apk.sha256`、`.apk.build.json`、`SHA256SUMS`）。再 `gh workflow run release-mobile.yml --ref main -f tag=app-vX.Y.Z`：复核源码提交、版本、身份、签名与 ZIP 布局后以 `latest=false` 公开，并镜像到 GitCode。
4. 真机记录 Android API、ABI、WebView 版本；用相同固定签名的前一版本覆盖升级，验证藏书 / 阅读进度 / 设置保留、离线启动、导入和阅读，以及点开下载 → 返回应用 → 版本检查。

### Android 身份与签名

- 仍是**实验性 arm64 debug 包**，应用身份 `com.yzfly.lightread.debug`；不能去掉 `.debug`、改用 release 构建或替换证书来“修复”覆盖升级。
- 固定密钥 `~/.config/lightread/signing/lightread-android.jks`，本机备份 `~/.local/share/lightread/signing-backup/lightread-android.jks`，异地备份 R2 私有桶 `yzfly-signing-backup/lightread/lightread-android.jks`（恢复方法见同目录 README.txt）。别名 `androiddebugkey`，store / key password 均为 `android`；GitHub secret `ANDROID_KEYSTORE_B64` 与变量 `ANDROID_CERT_SHA256` 已配置。公开证书 SHA256：`56103db2e518cf800db66d148d45f886e93c12b1afc8944ec668713636c7bada`。不要覆盖密钥文件、复用其他项目签名、提交密钥或打印 secret。
- v1.4.0 之前的 APK 用过 CI 临时密钥，无法承诺跨这些版本覆盖升级。历史用户按 README 的 Android 备份 / 恢复说明迁移；签名不一致时只做经授权的数据迁移，不得默默卸载旧应用、清空数据，也不能用卸载重装充当覆盖升级验收。

### 镜像与保留

- **GitCode**（`langgpt/LightRead`，GitCode 没有 yzfly 用户；应用内 `MIRROR_REPO` 与离线语音包都指向它）：公开后由 `mirror-gitcode` job 同步，逐个回下载校验 SHA-256，`SHA256SUMS` 最后上传；更新器只采用带 `SHA256SUMS` 的镜像版本。未配置 secret `GITCODE_TOKEN` 时（当前就是这样），release workflow 结束后**直接**在本机运行 `scripts/mirror-gitcode-cli.sh <tag>`（幂等）：本机 GitCode CLI 已登录 langgpt（`~/.config/gc/auth.json`），缺 tag 时脚本自己推送，不需要再找令牌、查 jiangshu-infra 或等 pull 镜像。每条线只留最新版：脚本删除同一条线上更旧的 Release，`tts-models` 保留；GitCode API 删不掉的会列出来，需在网页手动删。镜像失败不影响 GitHub Release，不要把镜像变成 publish 的前置条件。详见 `docs/gitcode-mirror.md`。
- **GitHub**（2026-10-05 用户定）：每条线保留最新版与各小版本的最后一版，其余 Release 删除，git tag 保留。
