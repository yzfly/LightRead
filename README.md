<div align="center">

<img src="public/favicon.svg" width="88" alt="LightRead logo" />

# LightRead 轻阅

**开源、本地优先的全格式电子书阅读器，给爱读书的人。**

你的书、你的进度、你的批注，全部在你自己的设备上。<br/>没有账号，没有云端，没有追踪。

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Web%20(PWA)-1664FF)
![Tauri](https://img.shields.io/badge/Tauri%202-Rust-orange)
![Vue 3](https://img.shields.io/badge/Vue%203-TypeScript-42b883)

<img src="docs/screenshots/library.png" width="880" alt="藏书书架" />

</div>

---

## 为什么是轻阅

- **全格式**：EPUB · MOBI · AZW / AZW3 · FB2 / FB2.zip · CBZ 漫画 · PDF · TXT · HTML · Markdown ——一个阅读器读完所有书
- **轻**：安装包仅 ~8MB（Tauri 2 / Rust），冷启动秒开
- **本地优先**：书籍文件就在你选的文件夹里，Finder 可见、随时拿走；放进 iCloud / 网盘同步文件夹即可多设备共享
- **认真做阅读**：对标微信读书的完整阅读体验，做给每天真的在读书的人

## ✨ 功能

### 阅读体验

<div align="center"><img src="docs/screenshots/reader.png" width="880" alt="阅读界面 - 护眼绿主题双栏" /></div>

- 翻页 / 滚动双模式，宽屏自动双栏，平滑翻页动画
- 白 / 米黄 / **护眼绿** / 夜间四主题；字号、行距、边距、字体自由调节
- 目录导航、书内全文搜索、精确进度记忆（EPUB CFI）
- **四色划线 + 写想法**、书签收藏位置
- **自动阅读**：3–60 秒/页滑条调速，解放双手
- 阅读时长统计：每本书的时间都算数

### 听书（TTS）

<div align="center"><img src="docs/screenshots/tts.png" width="880" alt="听书 - 在线神经音色" /></div>

- **在线神经音色**（微软 Edge 大声朗读服务）：晓晓、云希、东北话晓北、陕西话晓妮、粤语、台湾腔等 13 个音色，音质接近真人
- 系统语音离线兜底，断网自动回退
- EPUB 听书**视图自动跟随**朗读进度；PDF 逐页朗读自动翻页
- 语速 0.5–2x

### PDF 阅读

<div align="center"><img src="docs/screenshots/pdf-spread.png" width="880" alt="PDF 双页并列" /></div>

- 默认**适高整页**，像拿着一本真书；**双页并列**像摊开书
- 连续滚动模式细读大图，视口外内存自动回收，千页扫描件不卡
- 触摸滑动翻页（触控板 / 移动端）

### 藏书与书源

<div align="center"><img src="docs/screenshots/sources-arxiv.png" width="880" alt="arXiv 书源" /></div>

- 拖拽批量导入，自动提取元数据与封面；批量管理、标签筛选
- **OPDS 开放书源**：内置古登堡计划（7 万本公版书）；可接入任意 OPDS 地址（calibre-web、Calibre 内容服务器…），支持账号鉴权
- **arXiv 论文**：12 个分类刷最新论文、全文搜索、一键下载入库即读
- **Calibre 书库直读**：指向你的 Calibre 文件夹，书目封面即刻可见，点一本就读
- **网络代理**：HTTP / HTTPS / SOCKS4 / SOCKS5，与 Clash 等工具直接配合
- 一键 zip 备份 / 恢复，跨端迁移

## 📦 安装

### macOS（Apple Silicon）

从 [Releases](https://github.com/yzfly/LightRead/releases) 下载最新 `LightRead_x.y.z_aarch64.dmg`，拖入应用程序文件夹。

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
│  foliate-js  │    pdf.js     │  TXT/MD/HTML │
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

## 🗺 路线图

- [x] **M1**：全格式阅读、藏书管理、OPDS + arXiv 书源、备份、PWA、macOS 桌面
- [x] **M2**：听书（Edge 神经音色）、想法批注、书签、阅读时长、自动阅读、PDF 双页
- [x] **M2.5**：批量管理、Calibre 直读、网络代理、自选存储位置
- [ ] **M3**：iOS / Android（Tauri Mobile）、本地离线神经语音（sherpa-onnx + Kokoro）、DjVu / CBR、WebDAV 同步、Windows / Linux 安装包

> KFX（新版 Kindle）为重 DRM 格式不支持，请先用 [Calibre](https://calibre-ebook.com/) 处理。

## 📄 协议

[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)（署名-非商业性使用）

作者：**云中江树**（微信公众号：云中江树）

致谢：[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) · [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) · 截图书籍来自 [古登堡计划](https://www.gutenberg.org/)
