// 读者反馈过的问题, 每条一组回归用例; 桌面与 App 发版 workflow 都跑, 不过不发版。
// 新的读者反馈修好后在这里加一组, 写清楚反馈日期和现象。
//   npm run test:reader-feedback
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// 前端源码里的相对导入不写 .ts (由 Vite 补), 直接在 node 里跑时补上
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Vite 的 `?url` 资源导入 (字体等): 换成导出该路径字符串的模块
    if (specifier.endsWith('?url')) {
      return { shortCircuit: true, url: `data:text/javascript,export default ${encodeURIComponent(JSON.stringify(specifier.slice(0, -4)))}` }
    }
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const url = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(url))) return { shortCircuit: true, url: url.href }
    }
    return nextResolve(specifier, context)
  },
})

const { textBookTitle } = await import('../src/services/textToEpub.ts')
const { ACCEPT_APP, APP_BOOK_MIME_TYPES } = await import('../src/services/plainText.ts')
const { SUPPORTED_EXTS } = await import('../src/services/format.ts')
const { draftHasTag, parseTagDraft, toggleTagInDraft } = await import('../src/services/tagDraft.ts')
const { EXTRA_OPEN_MIME_TYPES, patchManifest } = await import('./patch-android-project.mjs')

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

// 2026-11-23 Android: 很多 MD 文件在书架上不显示文件名, 只显示正文第一个标题 (「概述」「Day 1」…)
test('Markdown 书名取文件名, 不取正文第一个标题', () => {
  assert.equal(textBookTitle('读书笔记.md', 'md'), '读书笔记')
  assert.equal(textBookTitle('notes/2026 计划.markdown', 'md'), '2026 计划')
  assert.equal(textBookTitle('C:\\docs\\周报.md', 'md'), '周报')
  // 其他文本格式保持原样: 小说取文件名, 源码保留扩展名, HTML 用 <title>
  assert.equal(textBookTitle('三体.txt', 'txt'), '三体')
  assert.equal(textBookTitle('package.json', 'txt'), 'package.json')
  assert.equal(textBookTitle('page.html', 'html', '  网页标题 '), '网页标题')
  assert.equal(textBookTitle('page.html', 'html', ''), 'page')
  // 实际导入走 convertToEpub: Markdown 分支不能再用第一章标题覆盖书名
  const src = read('src/services/textToEpub.ts')
  const mdBranch = src.slice(src.indexOf("} else if (format === 'md') {"), src.indexOf('} else {', src.indexOf("} else if (format === 'md') {")))
  assert.doesNotMatch(mdBranch, /title\s*=/, 'Markdown 分支又在改书名')
})

// 2026-11-23 Android: azw / azw3 选不上, 改名成 .epub 才能导入
test('App 文件选择框带上电子书 MIME 与 octet-stream, azw / azw3 不再是灰的', () => {
  const accept = ACCEPT_APP.split(',')
  // Android 选择器只认 MIME (扩展名查不到 MIME 就被丢掉); 文件管理器把 azw / azw3 报成这几种
  for (const type of ['application/octet-stream', 'application/vnd.amazon.ebook', 'application/vnd.amazon.mobi8-ebook', 'application/x-mobipocket-ebook']) {
    assert.ok(accept.includes(type), type)
  }
  for (const type of APP_BOOK_MIME_TYPES) assert.ok(accept.includes(type), type)
  for (const ext of SUPPORTED_EXTS) assert.ok(accept.includes(`.${ext}`), ext)
  const view = read('src/mobile/views/LibraryView.vue')
  assert.match(view, /type="file" multiple :accept="ACCEPT_APP"/, 'App 藏书页的选文件框必须用 ACCEPT_APP')
})

// 2026-11-23 Android: 不能用轻阅直接打开书籍文件, 只能先添加再打开
const TEMPLATE_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="@string/app_name">
        <activity
            android:launchMode="singleTask"
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <!-- tauri-file-associations. AUTO-GENERATED. DO NOT REMOVE. -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="application/epub+zip" />
            </intent-filter>
        </activity>
        <provider
          android:name="androidx.core.content.FileProvider"
          android:authorities="\${applicationId}.fileprovider"
          android:exported="false"
          android:grantUriPermissions="true" />
    </application>
</manifest>
`

test('Android 清单: 「打开方式」补上 azw3 等常见的非标准 MIME, 且只加一次', () => {
  const once = patchManifest(TEMPLATE_MANIFEST)
  assert.equal(patchManifest(once), once, '补丁要幂等')
  const activity = once.slice(once.indexOf('android:name=".MainActivity"'), once.indexOf('</activity>'))
  for (const action of ['VIEW', 'SEND', 'SEND_MULTIPLE']) assert.ok(activity.includes(`android.intent.action.${action}"`), action)
  for (const type of ['application/octet-stream', 'application/vnd.amazon.mobi8-ebook', 'text/x-markdown']) {
    assert.ok(EXTRA_OPEN_MIME_TYPES.includes(type), type)
    assert.ok(activity.includes(`android:mimeType="${type}"`), type)
  }
})

test('Android: 系统交来的 content:// 文件拷进收件箱后由网页导入并打开', () => {
  // tao 交给 Rust 的是 content:// 地址, lib.rs 转不成文件路径会直接丢掉; 必须由 MainActivity 拷副本
  const kt = read('src-tauri/android/MainActivity.kt')
  assert.match(kt, /override fun onNewIntent\(intent: Intent\)[\s\S]*?receiveOpenIntent\(intent\)/, '应用已在运行时也要接住新文件')
  assert.match(kt, /override fun onCreate[\s\S]*?receiveOpenIntent\(intent\)/, '冷启动时要接住文件')
  assert.match(kt, /File\(cacheDir, "open-inbox"\)/)
  assert.match(kt, /addJavascriptInterface\(OpenBridge\(\), "LightReadOpen"\)/)
  for (const action of ['ACTION_VIEW', 'ACTION_SEND', 'ACTION_SEND_MULTIPLE']) assert.ok(kt.includes(`Intent.${action} ->`), action)
  const web = read('src/services/externalOpen.ts')
  assert.match(web, /window\.LightReadOpen\?\.take\(\)/)
  assert.match(web, /window\.__lightreadOpenFiles = /)
  // read_open_file 只放行 cache/open-inbox/ 的直接子文件, 规则由 cargo test android_open_inbox 覆盖
  const rs = read('src-tauri/src/lib.rs')
  assert.match(rs, /fn android_open_inbox_only_accepts_direct_children_without_parent_dirs/)
  assert.match(read('src/mobile/App.vue'), /startExternalOpen\(router\)/, 'App 启动时要接系统交来的文件')
})

// 2026-11-23: 给选中的书设置标签时, 希望能点选已有标签
test('批量设置标签: 点选已有标签与手输结果一致', () => {
  assert.deepEqual(parseTagDraft('科幻，待读、 科幻 ,,'), ['科幻', '待读'])
  assert.equal(toggleTagInDraft('', '科幻'), '科幻')
  assert.equal(toggleTagInDraft('科幻', '待读'), '科幻，待读')
  assert.equal(toggleTagInDraft('科幻，待读', '科幻'), '待读')
  assert.equal(toggleTagInDraft('自己输的, 科幻', '历史'), '自己输的，科幻，历史')
  assert.ok(draftHasTag('科幻, 待读', '待读'))
  assert.ok(!draftHasTag('科幻待读', '待读'))
  for (const view of ['src/views/LibraryView.vue', 'src/mobile/views/LibraryView.vue']) {
    const src = read(view)
    const modal = src.slice(src.indexOf("t('library.tagModalTitle'"), src.indexOf("t('library.clearTags')"))
    assert.match(modal, /v-for="tag in allTags"[\s\S]*?toggleTagInDraft\(tagDraft, tag\)/, `${view}: 标签弹窗要列出已有标签供点选`)
    assert.match(src, /const tags = parseTagDraft\(tagDraft\.value\)/, `${view}: 提交时按同一规则拆分`)
  }
})

// 2026-11-25 Windows (issue #25): 听书时耳机线控键能暂停, 再按一次不能继续。
// 听书用 Web Audio 出声, Chromium / WebView2 看不到媒体元素在播, 系统媒体键每次都发 'pause'
test('耳机 / 媒体键: 暂停后再按「暂停」等于继续, 「播放」不打断正在读的', async () => {
  const { mediaKeyCommand } = await import('../src/services/listenMediaKeys.ts')
  assert.equal(mediaKeyCommand('pause', 'playing'), 'pause')
  assert.equal(mediaKeyCommand('pause', 'paused'), 'resume')
  assert.equal(mediaKeyCommand('pause', 'stopped'), 'none')
  assert.equal(mediaKeyCommand('play', 'paused'), 'resume')
  assert.equal(mediaKeyCommand('play', 'stopped'), 'start')
  assert.equal(mediaKeyCommand('play', 'playing'), 'none')
  for (const view of ['src/views/ReaderView.vue', 'src/mobile/views/ReaderView.vue']) {
    const src = read(view)
    const setup = src.slice(src.indexOf('function setupMediaSession()'), src.indexOf('function updateMediaSession()'))
    for (const action of ['play', 'pause']) {
      assert.match(setup, new RegExp(`on\\('${action}', \\(\\) => runMediaKey\\('${action}'\\)\\)`), `${view}: '${action}' 要按当前状态决定做什么`)
    }
  }
})

// 2026-11-26 Windows v2.11.2 (issue #25 复现): 上面的改法没生效。WebView2 只在 AudioContext 出声时挂系统媒体会话,
// 暂停时会话消失, 第二下媒体键根本到不了页面。会话改由原生层按窗口持有, 暂停时保留为「已暂停」
test('Windows 媒体键: 系统媒体会话在原生层, 暂停后仍在', () => {
  const conf = JSON.parse(read('src-tauri/tauri.windows.conf.json'))
  const args = conf.app.windows[0].additionalBrowserArgs ?? ''
  assert.match(args, /--disable-features=[^ ]*HardwareMediaKeyHandling/, 'WebView2 自己的媒体会话要关掉, 免得系统里有两个')
  for (const keep of ['msWebOOUI', 'msPdfOOUI', 'msSmartScreenProtection']) assert.ok(args.includes(keep), `保留 wry 默认关掉的 ${keep}`)
  assert.match(read('src-tauri/src/lib.rs'), /media_controls::media_controls_update/, '原生命令要注册')
  const native = read('src-tauri/src/media_controls.rs')
  assert.match(native, /MediaPlaybackStatus::Paused/, '暂停时会话保留为已暂停')
  const src = read('src/views/ReaderView.vue')
  const setup = src.slice(src.indexOf('function setupMediaSession()'), src.indexOf('function updateMediaSession()'))
  assert.match(setup, /onMediaControlsButton\(onMediaButton\)/, '阅读页要接原生按键')
  const update = src.slice(src.indexOf('function updateMediaSession()'), src.indexOf('function clearMediaSession()'))
  assert.match(update, /syncMediaControls\(\{ state: ttsState\.value/, '播放 / 暂停状态要上报原生层')
})

// 2026-11-15 Windows / 2026-11-23 iOS (issue #24): 选了楷体正文不变 —— 书里 body / p 自带的
// font-family 盖过了只写在 html 上的阅读字体 (多见于中文 EPUB)
test('阅读字体盖过书自带的字体, 代码类元素保留等宽', async () => {
  const prefs = { theme: 'light', fontSize: 18, fontFamily: '', lineHeight: 1.8, letterSpacing: 0, justify: true }
  const override = /body, body :not\(pre\):not\(code\):not\(kbd\):not\(samp\):not\(tt\) \{ font-family: inherit !important; \}/
  for (const path of ['../src/services/readerTheme.ts', '../src/mobile/services/readerTheme.ts']) {
    const { FONT_FAMILIES, getReaderCSS } = await import(path)
    assert.doesNotMatch(getReaderCSS(prefs, false), override, `${path}: 默认字体时用书自己的字体`)
    for (const { value } of FONT_FAMILIES.filter(f => f.value)) {
      const css = getReaderCSS({ ...prefs, fontFamily: value }, false)
      assert.ok(css.includes(`font-family: ${value} !important;`), `${path}: html 上要写选中的字体`)
      assert.match(css, override, `${path}: 选了 ${value} 时正文要继承它`)
    }
  }
})
