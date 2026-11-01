<div align="center">

<img src="public/favicon.svg" width="76" alt="LightRead logo" />

# LightRead · Free, open-source ebook reader for every format

**Turn your reading list into time well spent.**

EPUB / PDF / MOBI / AZW3 / TXT and more · Key-idea highlighting · Many reading modes · Text to speech · Bilingual PDF translation · Sync across devices

[中文](README.md) · English

[![Latest release](https://img.shields.io/github/v/release/yzfly/LightRead?display_name=tag&sort=semver)](https://github.com/yzfly/LightRead/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/yzfly/LightRead/total)](https://github.com/yzfly/LightRead/releases)
[![License: AGPL v3+](https://img.shields.io/badge/License-AGPL_v3%2B-blue.svg)](LICENSE)

**[Website](https://code.jiangshu.ai/LightRead/)** · **[Download for desktop](https://code.jiangshu.ai/LightRead/#download)** · **[Download the Android app](https://code.jiangshu.ai/LightRead/download/android)** · [China mirror (GitCode)](https://gitcode.com/langgpt/LightRead/releases) · [User guide (中文)](https://code.jiangshu.ai/LightRead/manual/) · [Feedback](https://github.com/yzfly/LightRead/issues)

Windows · macOS · Linux · Android · Web PWA

Free, open source, no ads. Local reading needs no account or internet connection; your books, progress, and notes stay on your device by default.

<img src="docs/screenshots/feature-library.png" width="1000" alt="LightRead local ebook library with cover grid, tags, custom booklists and reading progress" />

</div>

[PDF translation](#pdf-translation-keep-the-original-in-view) · [Guided reading](#guided-reading-let-the-key-ideas-stand-out) · [Booklists](#booklists-give-your-next-read-a-place) · [Reading stats](#reading-stats-see-your-reading-add-up) · [Listen & focus](#listen--focus-read-at-your-own-pace)

## LightRead at a glance

| | |
| --- | --- |
| What it is | An open-source, local-first reader for ebooks and PDFs: books, research papers, and audio reading in one app |
| Devices | Windows 10/11, macOS (Apple Silicon and Intel), Linux (deb / rpm / AppImage), Android (arm64), web PWA |
| Formats | EPUB, PDF, MOBI, AZW, AZW3, FB2, TXT, Markdown, HTML, DjVu, CBZ / CBR comics, plus plain-text files such as source code and logs |
| Reading modes | Key-idea highlighting (key words and key sentences), typewriter, lyrics, bionic-style word guide, auto page turn and smooth scroll, read-along with text to speech; night, eye-care, e-ink, large-text, and immersive scenes |
| Layout | Paginated, per-chapter scroll, or continuous scroll across chapters; one or two columns; font size, line height, margins, fonts, and themes; volume-key page turning and PDF reflow on Android |
| Sync | LightRead account or WebDAV syncs progress, notes, bookmarks, booklists, reading history, and settings; portable library export / import |
| Cost & privacy | Free, AGPL-3.0; usable without an account; online features are opt-in |
| Not supported | KFX and DRM-protected files |

## Android app

The Android app shares the desktop reading engine with an interface designed for phones: bottom tabs, a reachable reader toolbar, and bottom-sheet panels.

| Library | Reading with highlights | Reading modes | Layout · volume keys |
| --- | --- | --- | --- |
| <img src="docs/screenshots/app-library.png" width="200" alt="LightRead Android app library with continue-reading card, today's reading time, tags, and cover grid" /> | <img src="docs/screenshots/app-reader.png" width="200" alt="LightRead Android reader highlighting key Chinese words offline" /> | <img src="docs/screenshots/app-reading-modes.png" width="200" alt="LightRead Android reading modes: key-idea highlighting, night, eye care, e-ink, large text, immersive, ambient sound" /> | <img src="docs/screenshots/app-typography.png" width="200" alt="LightRead Android layout panel: paginated, chapter scroll, continuous scroll, progress display, and volume-key page turning" /> |

| Listen | Book sources | Reading stats |
| --- | --- | --- |
| <img src="docs/screenshots/app-listen.png" width="200" alt="LightRead Android text to speech with sleep timer, voice, speed, and time remaining" /> | <img src="docs/screenshots/app-sources.png" width="200" alt="LightRead Android book sources: unified search, Project Gutenberg, Internet Archive, arXiv, and private libraries" /> | <img src="docs/screenshots/app-stats.png" width="200" alt="LightRead Android reading stats: daily goal, streak, weekly progress, and reading time" /> |

<sub>App screenshots render the app interface in a phone-sized (390 × 844) browser with demo books and reading history; on a real phone, text to speech defaults to online voices. [Reproduce the screenshots](docs/screenshots/README.md).</sub>

## A local library for the books you want to read

**Drop in a file and start reading.** Organize your collection with covers, tags, booklists, and progress tracking. Research papers have their own library.

Read **EPUB, PDF, MOBI, AZW / AZW3, TXT, and Markdown**, plus FB2, CBZ / CBR comics, DjVu, HTML, and plain-text files such as source code and logs. MOBI, AZW3, FB2, and TXT can also be converted to EPUB. KFX and DRM-protected files are not supported.

## PDF translation: keep the original in view

**Original on the left. Translation on the right.** Translate a selection or read page-by-page translations alongside the original layout. On desktop, **BabelDOC** can also generate translated or bilingual PDFs.

<img src="docs/screenshots/feature-pdf-translation.png" width="1000" alt="LightRead bilingual PDF reader showing an English document beside its Chinese translation" />

Go deeper with the desktop **paper agent and ten-question workflow**. Explore arguments, methods, and evidence while keeping your own answers separate from AI output. [Paper workflow guide (中文) →](docs/paper-reading.md)

<details>
<summary>Translation and AI requirements</summary>

Selection and page translation use the configured AI service. BabelDOC requires desktop, an additional runtime/model download, and a personal model service configuration. Provider fees may apply. The paper agent requires a separately installed and configured Pi, Codex, or Claude Code engine. Scanned PDFs can be displayed, but text selection and text analysis require a text layer; built-in OCR is not provided.

</details>

## Guided reading: let the key ideas stand out

**Dianjing (点睛阅读) adds cues to the original text.** Basic mode marks word boundaries or keywords offline. Smart mode uses AI to identify key sentences, concepts, and contextual notes, with chapter summaries, a book outline, and a skim view for review.

<img src="docs/screenshots/feature-dianjing.png" width="1000" alt="LightRead Dianjing guided reading highlighting keywords directly in an ebook while preserving the full text" />

Basic mode is pictured. Smart mode sends text to the selected AI service after consent. Available for reflowable ebooks such as EPUB and TXT, not PDFs or fixed-layout books. [Guided reading guide (中文) →](docs/manual/05-点睛阅读.md)

## Booklists: give your next read a place

**Keep books you own and books you still want in the same list.** Add wanted titles, match them automatically when imported, explore curated lists, and export a list to share.

<img src="docs/screenshots/feature-booklists.png" width="1000" alt="LightRead booklist combining imported ebooks and wanted titles with search and sharing actions" />

## Reading stats: see your reading add up

**Today's minutes. This week's books. The habit you're building.** Track a daily goal, reading streaks, weekly/monthly/yearly trends, and a reading calendar.

<img src="docs/screenshots/feature-reading-stats.png" width="1000" alt="LightRead reading history dashboard with daily goal, reading streak, weekly chart and milestones" />

## Listen & focus: read at your own pace

**Rest your eyes and let the book speak.** Adjust speech speed, set a sleep timer, and resume where you left off. Try typewriter or lyric modes, automatic paging, ambient audio, and night, eye-care, or large-text presets.

| Listen to your books | Find a comfortable reading mode |
| --- | --- |
| [![LightRead text-to-speech controls with voice, speed and sleep timer](docs/screenshots/feature-listen.png)](docs/screenshots/feature-listen.png) | [![LightRead reading modes with guided reading, night, large text and immersive presets](docs/screenshots/feature-reading-modes.png)](docs/screenshots/feature-reading-modes.png) |

Desktop supports online voices, optional downloadable offline models, and system speech. The web version uses system speech. [Speech and ambient audio guide (中文) →](docs/manual/03-声音.md)

## Book discovery: find something worth opening

**Search books, find papers, and explore curated lists in one place.** Connect Project Gutenberg, Internet Archive, arXiv, OPDS / Calibre catalogs, or a self-hosted library.

<img src="docs/screenshots/feature-discovery.png" width="1000" alt="LightRead book discovery with search across public sources, curated reading lists and library connections" />

Enable curated booklists in Settings → Features. Availability, access conditions, and permissions depend on each source. [Self-hosted library guide (中文) →](docs/self-hosted-library.md)

## Pick up on another device

| What you want to do | How LightRead helps |
| --- | --- |
| Continue reading on another device | Optional account sync for progress, notes, bookmarks, booklists, and reading history; import book files separately |
| Sync the files too | Optional WebDAV file sync through your own cloud storage or NAS |
| Send text, links, or files | Transfer via your account, WebDAV, or a temporary pickup code |
| Back up or move your library | Import/export `.okf.zip` library packages; choose a custom storage location on desktop |
| Return to an idea | Highlights, notes, bookmarks, and in-book search |

Local data stays on your device by default. Online sources, speech, AI, and sync connect to their respective services; remote AI receives the relevant text. Library packages exclude app settings, credentials, and agent workspaces. [Sync guide (中文) →](docs/manual/04-使用说明.md#8-多端同步)

## Install

Desktop and Android are released separately; each channel below always has the latest of both. Installed apps also check for updates in-app.

| Channel | Link | For |
| --- | --- | --- |
| Fixed links on the website | `https://code.jiangshu.ai/LightRead/download/<platform>`: [windows](https://code.jiangshu.ai/LightRead/download/windows) · [mac](https://code.jiangshu.ai/LightRead/download/mac) · [mac-intel](https://code.jiangshu.ai/LightRead/download/mac-intel) · [linux](https://code.jiangshu.ai/LightRead/download/linux) · [linux-deb](https://code.jiangshu.ai/LightRead/download/linux-deb) · [linux-rpm](https://code.jiangshu.ai/LightRead/download/linux-rpm) · [android](https://code.jiangshu.ai/LightRead/download/android) | The link never changes and always serves the newest build; add `?mirror=gitcode` for the China mirror |
| GitHub Releases · desktop | [github.com/yzfly/LightRead/releases/latest](https://github.com/yzfly/LightRead/releases/latest) | Windows, macOS, Linux |
| GitHub Releases · Android | [Releases tagged `app-v…`](https://github.com/yzfly/LightRead/releases?q=app-v&expanded=true) | Android phones and tablets |
| GitCode mirror (China) | [gitcode.com/langgpt/LightRead/releases](https://gitcode.com/langgpt/LightRead/releases) | When GitHub is slow; desktop and Android |
| In-app update | Settings → About → Check for updates | Installed apps; falls back to the GitCode mirror when GitHub is unreachable |
| Build from source / web | See "Developers" below | Self-hosting the web PWA or development |

Pick the file for your device (`x.y.z` is the version):

| Device | File |
| --- | --- |
| Windows 10/11, 64-bit | `LightRead_x.y.z_x64-setup.exe` |
| macOS, Apple Silicon | `LightRead_x.y.z_aarch64.dmg` |
| macOS, Intel | `LightRead_x.y.z_x64.dmg` |
| Ubuntu / Debian | `LightRead_x.y.z_amd64.deb` |
| Fedora / RHEL | `LightRead-x.y.z-1.x86_64.rpm` |
| Other Linux | `LightRead_x.y.z_amd64.AppImage` |
| Android 7.0+, arm64 | `LightRead_app-vx.y.z_android_arm64.apk` |

Every release includes `SHA256SUMS` for verifying downloads. On macOS, open the DMG and drag LightRead into Applications. If blocked, verify the download came from this repository before using the system's **Open Anyway** option. On Windows, run the installer. On Linux, use your package manager or grant execute permission to the AppImage.

**Android:** the app is still experimental (package `com.yzfly.lightread.debug`); new versions with the same signature install over the old one. Historical builds used different signing keys. If installation conflicts, keep the old app until you have exported and verified a backup outside its private storage, then follow the [migration guide (中文)](docs/installation.md#android实验性).

<details>
<summary>Developers: build from source</summary>

The web frontend needs Node.js. Desktop development also needs Rust and the platform prerequisites for Tauri 2.

```bash
git clone https://github.com/yzfly/LightRead.git
cd LightRead
npm install
npm run dev          # Web development
npm run tauri dev    # Desktop development
```

Build with `npm run build` (frontend) or `npm run tauri build` (desktop). Built with Vue 3, TypeScript, Tauri 2/Rust, foliate-js, and MuPDF/PDFium. See [CLAUDE.md](CLAUDE.md) for development conventions.

</details>

## Help make LightRead better

If LightRead earns a place in your reading routine, **[give it a Star](https://github.com/yzfly/LightRead)**. [Feedback](https://github.com/yzfly/LightRead/issues), pull requests, and suggestions for lawfully available book sources are welcome.

<sub>Screenshots show the real app with Chinese UI. Library contents, reading history, and PDF translations are demo fixtures. Sample books and covers were made for this feature tour and are not bundled with the app. [Reproduce the screenshots](docs/screenshots/README.md).</sub>

## License and acknowledgments

[GNU AGPL v3.0 or later](LICENSE). Third-party components retain their respective licenses.

Thanks to [foliate-js](https://github.com/johnfactotum/foliate-js), [MuPDF](https://mupdf.com/), [PDFium](https://pdfium.googlesource.com/pdfium/), [BabelDOC](https://github.com/funstory-ai/BabelDOC), [jieba](https://github.com/fxsjy/jieba), and [DeepSeek-R1](https://huggingface.co/deepseek-ai/DeepSeek-R1).
