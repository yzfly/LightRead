<div align="center">

<img src="public/favicon.svg" width="88" alt="LightRead logo" />

# LightRead 轻阅

**开源、本地优先的全格式电子书阅读器，给爱读书的人。**

你的书、你的进度、你的批注，全部在你自己的设备上。<br/>没有账号，没有云端，没有追踪。

[![License: AGPL v3+](https://img.shields.io/badge/License-AGPL_v3%2B-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-1664FF)
![Tauri](https://img.shields.io/badge/Tauri%202-Rust-orange)
![Vue 3](https://img.shields.io/badge/Vue%203-TypeScript-42b883)

<img src="docs/screenshots/library.png" width="880" alt="藏书书架" />

</div>

---

## 为什么是轻阅

- **全格式**：EPUB · MOBI · AZW / AZW3 · FB2 / FB2.zip · CBZ / CBR 漫画 · PDF · **DjVu** · TXT · HTML · Markdown ——一个阅读器读完所有书
- **轻**：Tauri 2 / Rust 原生外壳，冷启动秒开
- **本地优先**：书籍文件就在你选的文件夹里，Finder 可见、随时拿走；放进 iCloud / 网盘同步文件夹即可多设备共享
- **找书不求人**：统一搜书跨古登堡计划 / GitHub 书库 / arXiv，搜《百年孤独》《万历十五年》，点一下下载入库即读
- **认真做阅读**：对标微信读书的完整阅读体验，做给每天真的在读书的人

## ✨ 功能

### 阅读体验

<div align="center"><img src="docs/screenshots/reader.png" width="880" alt="阅读界面 - 护眼绿主题双栏" /></div>

- **沉浸式阅读**：正文满屏、工具栏自动隐去；一键全屏，点正文左右翻页、中间呼出工具栏
- 翻页 / 滚动双模式，宽屏自动双栏，平滑翻页动画；触屏轻点 / 滑动翻页
- 白 / 米黄 / **护眼绿** / 夜间四主题；字号 12–64 可精准输入；系统字体任选，支持导入自定义字体文件
- **全书检索**：正则表达式、多关键词（同段落命中）、大小写 / 全词开关，结果按章节分组、命中词全部高亮
- **AI 阅读助手**：侧边栏随时问背景知识，划词一键 AI 解读；支持硅基流动 / 智谱（免费模型）、豆包、本地 Ollama 及任意 OpenAI 兼容接口
- **四色划线 + 写想法**、书签收藏位置；目录自动定位当前章节
- **自动阅读**调速翻页；阅读时长统计：每本书的时间都算数

### 听书（TTS）

<div align="center"><img src="docs/screenshots/tts.png" width="880" alt="听书 - 在线神经音色" /></div>

- **在线神经音色**（微软 Edge 大声朗读服务）：晓晓、云希、东北话晓北、陕西话晓妮、粤语、台湾腔等 13 个音色，音质接近真人
- **本地离线神经音色**（sherpa-onnx + Kokoro-82M v1.1-zh）：应用内一键下载 ~310MB 语音包，103 个中英音色完全离线合成，断网也是神经音质
- 系统语音兜底，三层引擎自动降级
- EPUB 听书**视图自动跟随**朗读进度；PDF 逐页朗读自动翻页
- 语速 0.5–2x

### PDF 阅读

<div align="center"><img src="docs/screenshots/pdf-spread.png" width="880" alt="PDF 双页并列" /></div>

- 默认**适高整页**，像拿着一本真书；**双页并列**像摊开书
- 使用与 SumatraPDF 同源的 **MuPDF** 内核绘制页面，按设备像素比渲染清晰正文
- 连续滚动模式细读大图，视口外内存自动回收，千页扫描件不卡
- 触摸滑动翻页（触控板 / 移动端）

### 藏书与书源

<div align="center"><img src="docs/screenshots/sources-arxiv.png" width="880" alt="arXiv 书源" /></div>

- **统一搜书**：一个搜索框跨平台找书——试试搜《百年孤独》《万历十五年》或 `dickens`，勾选 GitHub 书库 / 古登堡计划 / arXiv，结果按来源分组，点击直接下载入库
- **GitHub 书源列表（社区共建）**：内置 13 个书库仓库（[booksources.json](booksources.json) 随应用分发 + 手动更新），也可添加私人仓库；欢迎 PR 推荐书源
- 拖拽批量导入；**网页链接导入**（GitHub 文件页链接自动转直链）；自动提取元数据与封面；**置顶与分类管理**、批量操作、搜索排序
- **OPDS 开放书源**：内置古登堡计划（7 万本公版书）；可接入任意 OPDS 地址（calibre-web、Calibre 内容服务器…），支持账号鉴权
- **arXiv 论文**：12 个分类刷最新论文、全文搜索、一键下载入库即读
- **Calibre 书库直读**：指向你的 Calibre 文件夹，书目封面即刻可见，点一本就读
- **网络代理**：HTTP / HTTPS / SOCKS4 / SOCKS5，与 Clash 等工具直接配合
- 一键 zip 备份 / 恢复；**WebDAV 云备份**（坚果云 / Nextcloud / Alist），换设备一键恢复

## 📦 安装

从 [Releases](https://github.com/yzfly/LightRead/releases) 下载对应平台安装包：

| 平台 | 文件 |
|------|------|
| macOS (Apple Silicon) | `LightRead_x.y.z_aarch64.dmg` |
| macOS (Intel) | `LightRead_x.y.z_x64.dmg` |
| Windows | `LightRead_x.y.z_x64-setup.exe` / `.msi` |
| Linux | `.AppImage` / `.deb` / `.rpm` |
| Android (实验性) | `LightRead_x.y.z_android_arm64.apk` |

### 网页版 / PWA

```bash
npm install && npm run build
# dist/ 可部署到任意静态服务器, 浏览器里就是完整阅读器
```

### 从源码构建桌面版

需要 [Rust 工具链](https://www.rust-lang.org/tools/install)：

```bash
npm install
npm run tauri dev      # 开发
npm run tauri build    # 打包
```

## 🏗 架构

```
┌─────────────────────────────────────────────┐
│  Vue 3 + TypeScript (界面层)                 │
├──────────────┬───────────────┬──────────────┤
│  foliate-js  │ MuPDF+PDFium  │  TXT/MD/HTML │
│  EPUB MOBI   │     PDF       │  → 动态转EPUB │
│  AZW3 FB2 CBZ│               │              │
├──────────────┴───────────────┴──────────────┤
│  存储抽象层 (LibraryStorage)                  │
├──────────────────────┬──────────────────────┤
│  桌面 (Tauri 2/Rust)  │  Web / PWA           │
│  文件系统+SQLite      │  IndexedDB           │
│  自选存储位置          │                      │
│  Edge TTS / Calibre   │  fetch (+可选代理)    │
│  原生 HTTP (无跨域)    │                      │
└──────────────────────┴──────────────────────┘
```

阅读引擎采用 Linux 著名阅读器 [Foliate](https://github.com/johnfactotum/foliate) 的同款内核 [foliate-js](https://github.com/johnfactotum/foliate-js)；TXT 自动识别中文章节标题生成目录，GBK / GB18030 编码自动检测。

工程质量：44 项端到端回归测试 + Rust 单元测试 + WebKit 性能基准，每个版本全绿发布。

## 📚 GitHub 书源列表 (社区共建)

轻阅的「书源」页内置一份 GitHub 书库清单 ([booksources.json](booksources.json))，应用每 24 小时自动拉取最新版本。**欢迎共同维护**：

- **推荐书源**：提交 PR 修改 [booksources.json](booksources.json)，添加你发现的书籍仓库
- **收录标准**：仓库需直接存放书籍文件（epub / pdf / mobi / azw3 / txt 等）；纯链接聚合、网盘跳转类仓库不收录
- **格式**：`{ "repo": "owner/repo", "note": "一句话简介, 大致册数" }`
- 也可以在 [Issues](https://github.com/yzfly/LightRead/issues) 里分享你的书源清单，由维护者代为合入

应用内「书源 → GitHub 书源列表」还支持添加私人仓库（仅保存在本地，不参与社区清单）。

## 🗺 路线图

**账号与云能力的原则**：账号为功能服务，不为限流服务。不登录即是完整的本地阅读器；未来的云书架、跨设备同步等在线能力（计划基于 Supabase）需登录解锁，但永远不是使用前提。AI 试用通道采用匿名设备标识 + 每日配额，零注册、零个人数据。

- [x] **M1**：全格式阅读、藏书管理、OPDS + arXiv 书源、备份、PWA、macOS 桌面
- [x] **M2**：听书（Edge 神经音色）、想法批注、书签、阅读时长、自动阅读、PDF 双页
- [x] **M2.5**：批量管理、Calibre 直读、网络代理、自选存储位置
- [x] **M3**：本地离线神经语音（sherpa-onnx + Kokoro）、DjVu / CBR、WebDAV 云备份、Windows / Linux 安装包（CI 多平台构建）、Android 实验性 APK
- [ ] **M4**：iOS、Android 体验打磨、增量同步、更多本地音色引擎

> KFX（新版 Kindle）为重 DRM 格式不支持，请先用 [Calibre](https://calibre-ebook.com/) 处理。

## 📄 协议

[GNU Affero General Public License v3.0 or later](LICENSE)

LightRead 使用 AGPL 授权的 MuPDF，因此本项目整体以 AGPL-3.0-or-later 发布。分发修改版或通过网络向用户提供修改版服务时，须依照该协议提供对应源代码。

作者：**云中江树**（微信公众号：云中江树）

致谢：[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) · [MuPDF](https://mupdf.com/) (AGPL-3.0-or-later) · [PDFium](https://pdfium.googlesource.com/pdfium/) (BSD-3-Clause) · 截图书籍来自 [古登堡计划](https://www.gutenberg.org/)
