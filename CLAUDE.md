# LightRead 轻阅

开源、本地优先的电子书 / 论文阅读器。桌面 (Tauri 2) + 网页 PWA + Android 实验版。
产品定位与已定决策见 `docs/产品设计.md`，论文阅读链路见 `docs/paper-reading.md`。

## 技术栈

- 前端: Vue 3 `<script setup>` + TypeScript + Vite 8 + Pinia + vue-router (hash 路由，兼容 Tauri file 协议)
- 桌面壳: Tauri 2 (Rust, `src-tauri/`)；网页版部署到 Cloudflare (`wrangler.jsonc`, `relay/`)
- 阅读引擎: foliate-js (EPUB/MOBI/AZW3/FB2/CBZ + 转成内存 EPUB 的 TXT/HTML/MD)，PDF 走 MuPDF / PDFium wasm，DjVu 走 `src/vendor/djvu.js`
- 存储: `src/storage/` 的 `LibraryStorage` 抽象 — 桌面 `tauri.ts` (文件 + SQLite)，网页 `dexie.ts` (IndexedDB)
- 无 UI 组件库、无 Tailwind：样式全部是手写 CSS + `src/styles/main.css` 里的设计令牌

## 常用命令

```bash
npm run dev                 # vite 开发服务器, 固定 5173 端口 (strictPort)
npm run build               # vue-tsc -b && vite build
npx vue-tsc -b              # 只做类型检查
npm run test:paper-agent    # 论文 Agent 前端契约 (node --test)
npm run test:paper-context / test:keyboard-shortcuts / test:archive
cargo test --manifest-path src-tauri/Cargo.toml agent   # 论文 Agent 原生契约
npm run tauri dev|build     # 桌面 (需要 Rust 工具链)

# 端到端冒烟 (Playwright): 先构建并起预览, 再跑脚本 (脚本写死 http://localhost:4173)
npm run build && npx vite preview --port 4173 --strictPort &
npm run e2e                 # scripts/e2e-smoke.mjs, ~35 步: 导入 → 书单 → 阅读器 → PDF → 持久化
```

- 每次 `vite build` 后要**重启** `vite preview`（Cloudflare 插件会缓存资源清单，否则页面空白报 MIME 错误）。
- e2e 首次运行需要 `npx playwright install chromium`。

## 目录速览

```
src/
  App.vue              应用壳: 侧栏 / 平板图标栏 / 手机底部标签栏, 更新按钮
  views/               LibraryView(藏书+论文共用) ReaderView(foliate) PaperReaderView(PDF, 6.5k 行) DjvuReaderView CatalogView SettingsView
  components/          BookCard TocList ToastHost PaperAgentSidebar BabeldocTaskStatus
  stores/              settings.ts (localStorage, 带 SETTINGS_VERSION 迁移) library.ts
  services/            纯函数 / 平台适配: importer, opds, arxiv, tts, ai, paperAgent*, backup, appearance …
  i18n/                zh.ts (默认, 缺失回退来源) en.ts; t(key, params) 纯函数, key 为 'area.name' 字符串
  styles/main.css      设计令牌 + 全局组件类 (.btn .input .card .tag .segmented .modal .toast .empty .skeleton)
scripts/               e2e-smoke.mjs e2e-full.mjs perf.mjs 各类 node --test 契约测试
src-tauri/src/         Rust 命令: agent/ babeldoc calibre edge_tts local_tts fonts
```

## 约定

- **样式只用语义令牌**（`--bg --card --surface-2 --text --text-2 --text-3 --border --brand --brand-light --danger --success …`），不要在组件里写裸色值。深色模式通过 `<html data-theme="dark">` 重定义令牌实现，由 `services/appearance.ts` 依据 `settings.appearance` (system/light/dark) 写入。
- 全局类 `.segmented` 是设置页等的分段控件；阅读器工具栏各自有 scoped 的 `.seg`，不要合并。
- 图标一律内联 SVG（`aria-hidden="true"`），不用 emoji 当图标；图标按钮必须有 `aria-label`/`title`。
- 触屏设备不依赖 hover：`@media (hover: none)` 下提供可点的替代（如 BookCard 的「更多」按钮）。
- 所有用户可见文案走 `t()`，中英两个字典同时加 key，放在对应分区（`// ---- 藏书 ----` 等）。
- 新增设置项：在 `SettingsState` + `defaults` 里加字段即可（load 时自动 merge）；改历史默认值才需递增 `SETTINGS_VERSION` 并写迁移。
- Vue 模板里 `v-for` 变量不要用 `t`（会遮蔽 i18n 函数）。
- 组件样式用 `<style scoped>`；需要覆盖主题的选择器写成 `:root[data-theme='dark'] .x`。

## 边界 / 不要做

- **e2e 依赖的选择器别改语义**：`getByRole('button', { name })`（分段控件按钮不要改成 `role="radio"`），`button[title="目录"]` 等 title 文案，`.book-card` `.booklist-action` `.booklist-chip` `.sidebar-update`（收起 ≤42px、悬停 ≥108px）、`text=书架还是空的` / `这个书单还是空的` 等文案 key。改动后跑一遍 `npm run e2e`。
- `PaperReaderView.vue` 里仍有约 70 处硬编码浅色面板；深色主题下它不是完全适配的，改动前先看那一段样式。
- 不做 zlib 类站点直连、不支持 KFX（见产品设计文档），不引入组件库 / Tailwind。
- 阅读正文主题 (`settings.reader.theme`) 与应用外观 (`settings.appearance`) 是两回事，别互相绑定。
- 不要提交 `.env*`、`.corpus`、`dist`、`src-tauri/target`。

## 发版流程

1. 同步改 5 处版本号：`package.json`、`package-lock.json`(两处)、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`(lightread 包)、`src-tauri/tauri.conf.json`。
2. 提交信息 `release: vX.Y.Z`，正文即 GitHub Release 说明（`release.yml` 用 `head_commit.message` 作 releaseBody）。
3. `git tag -a vX.Y.Z && git push origin main vX.Y.Z` → 触发 `.github/workflows/release.yml`，四平台 (macOS arm64/x64, Ubuntu, Windows NSIS) 构建约 17 分钟。
4. 推送需要 yzfly 账号权限（`gh auth switch -u yzfly && gh auth setup-git`）。
