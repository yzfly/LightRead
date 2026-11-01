#!/usr/bin/env node
/**
 * 项目主页构建: site/ (手写首页与图片) + docs 里面向用户的文档 → site-dist/ (GitHub Pages 原样上传)。
 *
 *   node scripts/build-site.mjs [--out site-dist]
 *
 * 产物同时给人和给 AI 看:
 * - 手册与说明各章渲染成静态 HTML (manual/*.html, docs/*.html), 同名 .md 原文并列放着, 方便机器直接取 Markdown;
 * - llms.txt (来自仓库根目录, 补上主页地址) 与 llms-full.txt (llms.txt + 全部手册原文);
 * - sitemap.xml / robots.txt; 首页 JSON-LD 的版本号取自 package.json 与 tauri.android.conf.json。
 * 应用内链接指向这里的固定路径 (src/services/siteLinks.ts), 改路径要同时改那边。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { marked } from 'marked'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'site-dist')
export const SITE = 'https://code.jiangshu.ai/LightRead/'
const REPO_BLOB = 'https://github.com/yzfly/LightRead/blob/main/'

/** 仓库路径 → 站内路径。顺序即侧栏顺序 */
const PAGES = [
  { src: 'docs/manual/README.md', out: 'manual/index.html', group: 'manual', nav: '手册首页' },
  { src: 'docs/manual/04-使用说明.md', out: 'manual/guide.html', group: 'manual', nav: '使用说明' },
  { src: 'docs/manual/02-阅读模式.md', out: 'manual/reading-modes.html', group: 'manual', nav: '阅读模式与界面' },
  { src: 'docs/manual/05-点睛阅读.md', out: 'manual/dianjing.html', group: 'manual', nav: '点睛阅读' },
  { src: 'docs/manual/03-声音.md', out: 'manual/sound.html', group: 'manual', nav: '听书与背景音' },
  { src: 'docs/manual/01-读书方法.md', out: 'manual/reading-methods.html', group: 'manual', nav: '读书方法' },
  { src: 'docs/installation.md', out: 'docs/installation.html', group: 'docs', nav: '安装与升级' },
  { src: 'docs/paper-reading.md', out: 'docs/paper-reading.html', group: 'docs', nav: '论文阅读' },
  { src: 'docs/ambient-sources.md', out: 'docs/ambient-sources.html', group: 'docs', nav: '背景音来源与许可' },
  { src: 'docs/library-okf-profile.md', out: 'docs/library-okf-profile.html', group: 'docs', nav: '藏书包格式 (OKF)', lang: 'en' },
]
const BY_SRC = new Map(PAGES.map(p => [p.src, p]))

const read = p => readFileSync(join(ROOT, p), 'utf8')
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 与应用内 ManualView 一致的标题锚点 (同 GitHub): 小写, 去标点, 空白换成 - */
function slug(text) {
  return text.trim().toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

/** 文档里的相对链接: 站内有的改成站内页面, 首页 README 改到主页, 其余去 GitHub */
function rewriteHref(href, fromSrc, fromOut) {
  if (/^(https?:|mailto:|#)/i.test(href)) return href
  const [rawPath, hash] = href.split('#')
  let path = rawPath
  try { path = decodeURIComponent(rawPath) } catch { /* 保持原样 */ }
  const target = posix.normalize(posix.join(posix.dirname(fromSrc), path))
  const rel = to => posix.relative(posix.dirname(fromOut), to) || posix.basename(to)
  if (BY_SRC.has(target)) return rel(BY_SRC.get(target).out) + (hash ? `#${hash}` : '')
  if (target === 'README.md' || target === 'README.en.md') {
    const toHome = posix.relative(posix.dirname(fromOut), '') || '.'
    return `${toHome}/` + (hash && /下载|安装|android/i.test(decodeURIComponent(hash)) ? '#download' : '')
  }
  return REPO_BLOB + target + (hash ? `#${hash}` : '')
}

function render(md, page) {
  const used = new Map()
  const toc = []
  const renderer = new marked.Renderer()
  renderer.heading = function (token) {
    const text = this.parser.parseInline(token.tokens)
    let id = slug(token.text)
    const n = used.get(id) ?? 0
    used.set(id, n + 1)
    if (n) id = `${id}-${n}`
    if (token.depth === 2) toc.push({ id, text: token.text.replace(/[*`]/g, '') })
    return `<h${token.depth} id="${esc(id)}">${text}</h${token.depth}>\n`
  }
  const link = renderer.link
  renderer.link = function (token) {
    return link.call(this, { ...token, href: rewriteHref(token.href, page.src, page.out) })
  }
  const table = renderer.table
  renderer.table = function (token) {
    return `<div class="table-wrap">${table.call(this, token)}</div>`
  }
  return { html: marked.parse(md, { renderer, gfm: true, async: false }), toc }
}

/** 摘要: 首个 # 标题后第一段正文, 去掉 Markdown 记号 */
function summary(md) {
  const para = md.replace(/^#.*$/m, '').split(/\n\s*\n/).map(s => s.trim())
    .find(s => s && !/^(#|>|\||\[|-|\d+\.|```)/.test(s)) ?? ''
  return para.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').slice(0, 150)
}

const CSS = `
:root { --paper:#f6f1e7; --ink:#1b1f27; --ink-2:#474e5a; --ink-3:#6f7682; --rule:rgba(60,50,30,.14); --brand:#1a5fe0; --gold:#b07a2a; --code:rgba(70,55,30,.08);
  --glass:rgba(255,253,248,.62); --glass-edge:rgba(255,255,255,.75); --glass-line:rgba(70,55,30,.12);
  --shadow:0 1px 1px rgba(60,45,20,.04),0 10px 30px -8px rgba(60,45,20,.16),0 40px 80px -30px rgba(40,30,10,.18);
  --blob-1:#f1c27d; --blob-2:#8fb3ff; --blob-3:#c9d9b8;
  --serif:"Songti SC","STSong","Noto Serif CJK SC","Source Han Serif SC","Noto Serif SC","Iowan Old Style",Georgia,SimSun,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace; color-scheme:light; }
@media (prefers-color-scheme: dark) { :root { --paper:#0e1015; --ink:#ece8df; --ink-2:#b9b4a9; --ink-3:#8a867d; --rule:rgba(255,240,210,.10); --brand:#7aa6ff; --gold:#e0b265; --code:rgba(255,240,210,.08);
  --glass:rgba(28,31,39,.6); --glass-edge:rgba(255,255,255,.08); --glass-line:rgba(255,240,210,.09);
  --shadow:0 1px 1px rgba(0,0,0,.3),0 14px 40px -10px rgba(0,0,0,.6); --blob-1:#8a5a1e; --blob-2:#1f3f8f; --blob-3:#2d4a3a; color-scheme:dark; } }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; scroll-padding-top:88px; -webkit-text-size-adjust:100%; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior:auto; } }
body { margin:0; background:var(--paper); color:var(--ink); font-family:var(--sans); font-size:16px; line-height:1.85; -webkit-font-smoothing:antialiased; overflow-x:hidden; }
a { color:var(--brand); text-decoration:none; } a:hover { text-decoration:underline; text-underline-offset:3px; }
:focus-visible { outline:2px solid var(--brand); outline-offset:3px; border-radius:6px; }
.ambient { position:fixed; inset:0; z-index:-1; overflow:hidden; pointer-events:none; }
.ambient i { position:absolute; border-radius:50%; filter:blur(90px); opacity:.45; }
.ambient i:nth-child(1) { width:50vw; height:50vw; left:-16vw; top:-20vw; background:var(--blob-1); }
.ambient i:nth-child(2) { width:44vw; height:44vw; right:-18vw; top:30vh; background:var(--blob-2); opacity:.32; }
.ambient i:nth-child(3) { width:36vw; height:36vw; left:30vw; bottom:-24vw; background:var(--blob-3); opacity:.35; }
@media (prefers-color-scheme: dark) { .ambient i { opacity:.3; } }
.glass { background:var(--glass); -webkit-backdrop-filter:blur(22px) saturate(1.5); backdrop-filter:blur(22px) saturate(1.5); border:1px solid var(--glass-line); box-shadow:inset 0 1px 0 var(--glass-edge),var(--shadow); }
.wrap { max-width:1200px; margin:0 auto; padding-left:max(16px, env(safe-area-inset-left)); padding-right:max(16px, env(safe-area-inset-right)); }
@media (min-width:720px) { .wrap { padding-left:max(32px, env(safe-area-inset-left)); padding-right:max(32px, env(safe-area-inset-right)); } }
.nav { position:sticky; top:0; z-index:10; padding-top:max(10px, env(safe-area-inset-top)); }
.nav-bar { display:flex; align-items:center; gap:16px; height:56px; padding:0 10px 0 16px; border-radius:999px; }
.brand { display:flex; align-items:center; gap:10px; color:var(--ink); font-weight:600; font-size:16px; white-space:nowrap; } .brand:hover { text-decoration:none; }
.brand small { font-weight:400; color:var(--ink-3); font-size:13px; }
.nav-links { display:flex; align-items:center; gap:4px; margin-left:auto; font-size:15px; }
.nav-links a { color:var(--ink-2); padding:7px 12px; border-radius:999px; } .nav-links a:hover { background:var(--glass-line); text-decoration:none; color:var(--ink); }
.nav-links .nav-cta { background:var(--ink); color:var(--paper); font-weight:500; padding:8px 18px; margin-left:6px; } .nav-links .nav-cta:hover { background:var(--brand); color:#fff; }
.layout { display:grid; grid-template-columns:232px minmax(0,1fr); gap:32px; padding-top:28px; padding-bottom:64px; }
.side { position:sticky; top:92px; align-self:start; max-height:calc(100vh - 110px); overflow:auto; font-size:15px; border-radius:20px; padding:18px 12px; }
.side h2 { font-family:var(--serif); font-size:13px; letter-spacing:.24em; color:var(--gold); margin:4px 10px 8px; font-weight:600; }
.side ul { list-style:none; margin:0 0 18px; padding:0; display:grid; gap:2px; } .side ul:last-child { margin-bottom:0; }
.side a { display:block; padding:6px 10px; border-radius:10px; color:var(--ink-2); line-height:1.5; }
.side a:hover { background:var(--glass-line); text-decoration:none; color:var(--ink); }
.side a[aria-current="page"] { background:var(--ink); color:var(--paper); font-weight:500; }
.doc { min-width:0; border-radius:24px; padding:clamp(22px,5vw,64px); }
.doc article { max-width:760px; }
.doc h1 { font-family:var(--serif); font-size:clamp(30px,4.6vw,46px); line-height:1.25; letter-spacing:.01em; margin:0 0 20px; text-wrap:balance; }
.doc h2 { font-family:var(--serif); font-size:clamp(22px,3vw,29px); line-height:1.35; margin:52px 0 14px; padding-top:24px; border-top:1px solid var(--rule); text-wrap:balance; }
.doc hr + h2 { border-top:0; padding-top:0; }
.doc h1, .doc h2, .doc h3 { word-break:keep-all; overflow-wrap:anywhere; }
.doc h3 { font-family:var(--serif); font-size:20px; margin:34px 0 10px; } .doc h4 { font-size:17px; margin:24px 0 8px; }
.doc p, .doc li { color:var(--ink-2); } .doc strong { color:var(--ink); } .doc li + li { margin-top:4px; }
.doc blockquote { margin:22px 0; padding:6px 20px; border-left:2px solid var(--gold); background:var(--code); border-radius:0 12px 12px 0; }
.doc blockquote p { margin:10px 0; }
.doc code { font-family:var(--mono); font-size:.88em; background:var(--code); padding:1px 6px; border-radius:5px; word-break:break-word; }
.doc pre { background:var(--code); padding:14px 16px; border-radius:12px; overflow:auto; font-size:14px; line-height:1.6; } .doc pre code { background:none; padding:0; }
.table-wrap { overflow-x:auto; margin:18px 0; border:1px solid var(--glass-line); border-radius:14px; }
.doc table { border-collapse:collapse; width:100%; font-size:15px; }
.doc th, .doc td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--rule); vertical-align:top; }
.doc th { background:var(--code); color:var(--ink); font-weight:600; white-space:nowrap; }
.doc tr:last-child td { border-bottom:0; }
.doc td:first-child { white-space:nowrap; }
.doc hr { border:0; height:1px; background:var(--rule); margin:36px 0; }
.pager { display:flex; justify-content:space-between; gap:16px; margin-top:56px; padding-top:24px; border-top:1px solid var(--rule); font-size:15px; max-width:760px; }
.pager a { display:grid; gap:2px; max-width:48%; padding:10px 14px; border-radius:12px; } .pager a:hover { background:var(--glass-line); text-decoration:none; }
.pager small { color:var(--ink-3); } .pager .next { text-align:right; margin-left:auto; }
.src { margin:20px 0 0; font-size:13.5px; color:var(--ink-3); }
footer { padding:0 0 max(32px, env(safe-area-inset-bottom)); color:var(--ink-3); font-size:14px; }
footer .wrap > div { display:flex; flex-wrap:wrap; gap:10px 24px; justify-content:space-between; padding:20px 26px; border-radius:20px; }
footer nav { display:flex; flex-wrap:wrap; gap:6px 18px; } footer a { color:var(--ink-2); }
@media (max-width:900px) {
  .layout { grid-template-columns:minmax(0,1fr); gap:16px; padding-top:16px; }
  .side { position:static; max-height:none; padding:4px 14px; }
  .side details summary { cursor:pointer; padding:12px 0; font-weight:600; font-family:var(--serif); letter-spacing:.1em; }
  .side h2 { margin-left:0; } .side details[open] summary { margin-bottom:4px; }
  .nav-links a.hide-sm, .brand small { display:none; }
}
@media (min-width:901px) { .side details > summary { display:none; } }
`

function sideNav(current) {
  const item = p => {
    const href = posix.relative(posix.dirname(current.out), p.out) || posix.basename(p.out)
    return `<li><a href="${esc(href)}"${p === current ? ' aria-current="page"' : ''}>${esc(p.nav)}</a></li>`
  }
  return `<aside class="side glass" aria-label="文档目录"><details open><summary>文档目录</summary>
<h2>使用手册</h2><ul>${PAGES.filter(p => p.group === 'manual').map(item).join('')}</ul>
<h2>更多说明</h2><ul>${PAGES.filter(p => p.group === 'docs').map(item).join('')}</ul>
</details></aside>`
}

function pageHtml(page, md, versions) {
  const { html } = render(md, page)
  const h1 = (md.match(/^#\s+(.+)$/m)?.[1] ?? page.nav).replace(/[*`]/g, '').trim()
  const desc = summary(md) || `轻阅 LightRead ${page.nav}`
  const home = posix.relative(posix.dirname(page.out), '') || '.'
  const url = SITE + page.out
  const mdName = posix.basename(page.out).replace(/\.html$/, '.md')
  const i = PAGES.indexOf(page)
  const prev = PAGES[i - 1]
  const next = PAGES[i + 1]
  const rel = p => posix.relative(posix.dirname(page.out), p.out) || posix.basename(p.out)
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: h1,
    description: desc,
    inLanguage: page.lang ?? 'zh-CN',
    url,
    isPartOf: { '@type': 'WebSite', name: '轻阅 LightRead', url: SITE },
    about: { '@type': 'SoftwareApplication', name: 'LightRead 轻阅', softwareVersion: versions.desktop, url: SITE },
    encoding: { '@type': 'MediaObject', encodingFormat: 'text/markdown', contentUrl: SITE + posix.join(posix.dirname(page.out), mdName) },
  }
  return `<!doctype html>
<html lang="${page.lang ?? 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(h1)} · 轻阅 LightRead</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<link rel="alternate" type="text/markdown" href="${esc(mdName)}" title="Markdown 原文">
<link rel="icon" href="${home}/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0066cf">
<meta property="og:title" content="${esc(h1)} · 轻阅 LightRead">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}assets/feature-library.webp">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>${CSS}</style>
</head>
<body>
<div class="ambient" aria-hidden="true"><i></i><i></i><i></i></div>
<header class="nav"><div class="wrap"><div class="nav-bar glass">
  <a class="brand" href="${home}/"><img src="${home}/favicon.svg" alt="" width="28" height="28">轻阅 <small>LightRead</small></a>
  <nav class="nav-links" aria-label="主导航">
    <a class="hide-sm" href="${home}/#features">功能</a>
    <a href="${home}/manual/">手册</a>
    <a class="hide-sm" href="https://github.com/yzfly/LightRead">GitHub</a>
    <a class="nav-cta" href="${home}/#download">下载</a>
  </nav>
</div></div></header>
<div class="wrap layout">
${sideNav(page)}
<main class="doc glass" id="main">
<article>
${html}
</article>
<nav class="pager" aria-label="上一篇与下一篇">
${prev ? `<a class="prev" href="${esc(rel(prev))}"><small>上一篇</small>${esc(prev.nav)}</a>` : ''}
${next ? `<a class="next" href="${esc(rel(next))}"><small>下一篇</small>${esc(next.nav)}</a>` : ''}
</nav>
<p class="src"><a href="${esc(mdName)}">Markdown 原文</a> · <a href="${REPO_BLOB}${esc(page.src)}">在 GitHub 上查看或改进本页</a></p>
</main>
</div>
<script>if (matchMedia('(max-width: 900px)').matches) document.querySelector('.side details').removeAttribute('open')</script>
<footer><div class="wrap"><div class="glass">
  <span>轻阅 LightRead · AGPL-3.0 开源 · 桌面 v${esc(versions.desktop)} · App v${esc(versions.app)}</span>
  <nav aria-label="页脚"><a href="${home}/">主页</a><a href="${home}/manual/">使用手册</a><a href="https://github.com/yzfly/LightRead/issues">反馈</a><a href="${home}/llms.txt">llms.txt</a></nav>
</div></div></footer>
</body>
</html>
`
}

function build() {
  const versions = {
    desktop: JSON.parse(read('package.json')).version,
    app: JSON.parse(read('src-tauri/tauri.android.conf.json')).version,
  }
  rmSync(OUT, { recursive: true, force: true })
  cpSync(join(ROOT, 'site'), OUT, { recursive: true })

  // 首页: 版本号写进 JSON-LD 与页脚
  const indexPath = join(OUT, 'index.html')
  const index = readFileSync(indexPath, 'utf8')
    .replaceAll('__DESKTOP_VERSION__', versions.desktop)
    .replaceAll('__APP_VERSION__', versions.app)
  // 图片地址带内容哈希: 换截图后 Cloudflare / 浏览器缓存立即失效 (文件名不变)
  const versioned = index.replace(/(["(])(assets\/[\w.-]+\.(?:webp|png|jpg|svg))(?=[")])/g, (_, q, path) => {
    const file = join(ROOT, 'site', path)
    if (!existsSync(file)) throw new Error(`site/index.html 引用了不存在的 ${path}`)
    return `${q}${path}?v=${createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8)}`
  })
  if (versioned.includes('__')) {
    const left = versioned.match(/__[A-Z_]+__/)
    if (left) throw new Error(`site/index.html 里有未替换的占位符 ${left[0]}`)
  }
  writeFileSync(indexPath, versioned)

  const full = []
  for (const page of PAGES) {
    const md = read(page.src)
    const dest = join(OUT, page.out)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, pageHtml(page, md, versions))
    writeFileSync(dest.replace(/\.html$/, '.md'), md)
    full.push(`\n\n---\n\n<!-- source: ${SITE}${page.out} (Markdown: ${SITE}${page.out.replace(/\.html$/, '.md')}) -->\n\n${md.trim()}\n`)
  }

  const llms = read('llms.txt').replace(/\s*$/, '\n')
  writeFileSync(join(OUT, 'llms.txt'), llms)
  writeFileSync(join(OUT, 'llms-full.txt'),
    `${llms}\n## Current versions\n\n- Desktop: v${versions.desktop}\n- App (Android): app-v${versions.app}\n\n# Full user documentation (Chinese)\n${full.join('')}`)

  const today = new Date().toISOString().slice(0, 10)
  const urls = ['', ...PAGES.map(p => p.out.replace(/index\.html$/, ''))]
  writeFileSync(join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}\n</urlset>\n`)
  writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`)

  // 自检: 生成的站内相对链接都要落到真实文件上
  const missing = []
  for (const page of PAGES) {
    const html = readFileSync(join(OUT, page.out), 'utf8')
    for (const [, href] of html.matchAll(/href="([^"#:]+)(?:#[^"]*)?"/g)) {
      let target = posix.normalize(posix.join(posix.dirname(page.out), href))
      if (target.endsWith('/') || target === '.') target = posix.join(target, 'index.html')
      if (!existsSync(join(OUT, target))) missing.push(`${page.out} → ${href}`)
    }
  }
  if (missing.length) throw new Error(`站内链接指向不存在的文件:\n${missing.join('\n')}`)
  console.log(`site built: ${relative(ROOT, OUT)} (${PAGES.length} doc pages, desktop v${versions.desktop}, app v${versions.app})`)
}

build()
