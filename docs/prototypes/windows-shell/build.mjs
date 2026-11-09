// Windows 窗口外壳 (标题栏 + 左侧栏 + 页面上半部) 原型生成器: node build.mjs → 现状 / A / B / C 四个单文件 HTML
// 共用设计令牌与藏书页内容, 只换外壳布局。截图按 Win10 1080p·150% 的实际视口 1177×625。
import { writeFile } from 'node:fs/promises'

const tokens = `
:root{--brand:#0066cf;--brand-hover:#0054ad;--brand-light:#dceeff;--brand-soft:color-mix(in srgb,var(--brand) 10%,transparent);--on-brand:#fff;
--bg:#f3f5f8;--card:#fff;--surface-2:#ebeff3;--surface-3:#e6e8ec;--text:#202a36;--text-2:#535f6d;--text-3:#697787;--border:#e3e7ed;--border-strong:#cfd3da;
--danger:#e5383b;--radius-xs:4px;--radius-sm:6px;--radius:8px;--radius-lg:14px;--radius-pill:999px;
--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:20px;--space-6:24px;--space-8:32px;--space-10:40px;
--shadow-1:0 1px 2px rgba(29,33,41,.05);--shadow-2:0 2px 8px rgba(29,33,41,.06);--shadow-3:0 8px 28px rgba(29,33,41,.14);
--fs-caption:12px;--fs-small:13px;--fs-body:14px;--fs-subtitle:16px;--fs-title:20px;--fs-display:28px;--fw-regular:400;--fw-medium:500;--fw-semibold:600;
--font:-apple-system,BlinkMacSystemFont,'Segoe UI Variable','Segoe UI','Microsoft YaHei UI','PingFang SC',sans-serif;
--chrome:#eceff3;--chrome-line:#dde2e8}
html[data-theme=dark]{--brand:#4d9fff;--brand-hover:#6fb2ff;--brand-light:#1d3350;--on-brand:#0b1220;--bg:#16191e;--card:#1f2329;--surface-2:#262b32;--surface-3:#2d333b;
--text:#e6e9ee;--text-2:#aab3be;--text-3:#8792a0;--border:#2c323a;--border-strong:#3a414b;--chrome:#121418;--chrome-line:#262b32}
*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:var(--font);color:var(--text);font-size:var(--fs-body)}
body{background:#5fb8c8 radial-gradient(circle at 20% 30%,#7fd6d0,#3c8fb0);display:flex;align-items:center;justify-content:center}
.win{width:1177px;height:625px;border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column;background:var(--bg);box-shadow:0 10px 40px rgba(0,0,0,.25)}
button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}
svg{flex:none}
.ctl{display:flex;height:100%}.ctl button{width:46px;height:100%;display:grid;place-items:center;color:var(--text-2)}
.ctl button:hover{background:var(--surface-3)}.ctl button.x:hover{background:var(--danger);color:#fff}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:var(--space-3);height:36px;padding:0 var(--space-3);border-radius:var(--radius);color:var(--text-2);text-decoration:none;font-size:var(--fs-body)}
.nav a:hover{background:var(--surface-2)}
.nav a svg{width:18px;height:18px}
.logo{display:flex;align-items:center;gap:var(--space-2);font-weight:var(--fw-semibold)}
.logo i{width:24px;height:24px;border-radius:var(--radius-sm);background:var(--brand);display:grid;place-items:center}
.search{display:flex;align-items:center;gap:var(--space-2);height:34px;padding:0 var(--space-3);border-radius:var(--radius-pill);background:var(--surface-2);color:var(--text-3);font-size:var(--fs-small)}
.add{display:flex;align-items:center;height:34px;border-radius:var(--radius);background:var(--brand);color:var(--on-brand);font-weight:var(--fw-medium);font-size:var(--fs-small)}
.add span{padding:0 var(--space-4);display:flex;gap:6px;align-items:center}.add b{border-left:1px solid rgba(255,255,255,.3);width:32px;height:100%;display:grid;place-items:center}
.cont{display:flex;align-items:center;gap:var(--space-6);background:var(--card);border-radius:var(--radius-lg);padding:var(--space-5) var(--space-6);box-shadow:var(--shadow-1)}
.cover{border-radius:3px 5px 5px 3px;background:#c8dfcd;color:#5a4630;font-family:serif;padding:12px 10px;box-shadow:0 1px 2px rgba(29,33,41,.1),0 6px 14px -4px rgba(29,33,41,.18)}
.cont .cover{width:72px;height:100px;font-size:12px}
.cont .meta{flex:1;min-width:0}.cont .k{font-size:var(--fs-caption);color:var(--text-3)}.cont h3{margin:4px 0 2px;font-size:var(--fs-subtitle)}.cont .au{color:var(--text-2);font-size:var(--fs-small)}
.bar{display:flex;align-items:center;gap:var(--space-3);margin-top:var(--space-3)}.bar i{flex:1;height:4px;border-radius:2px;background:var(--surface-3);position:relative}.bar i:before{content:'';position:absolute;inset:0 99% 0 0;background:var(--brand);border-radius:2px}
.go{height:32px;padding:0 var(--space-4);border-radius:var(--radius);background:var(--brand);color:var(--on-brand);font-size:var(--fs-small)}
.stats{display:flex;gap:var(--space-8);padding-left:var(--space-6);border-left:1px solid var(--border)}.stats b{font-size:var(--fs-display);font-weight:var(--fw-semibold)}.stats small{color:var(--text-3)}.stats div div{font-size:var(--fs-caption);color:var(--brand)}
.lh{display:flex;align-items:center;gap:var(--space-3);margin:var(--space-6) 0 var(--space-3)}.lh b{font-size:var(--fs-subtitle)}.lh .n{color:var(--text-3)}.lh .sp{flex:1}
.chip{height:30px;padding:0 var(--space-3);border-radius:var(--radius);border:1px solid var(--border);display:flex;align-items:center;gap:4px;color:var(--text-2);font-size:var(--fs-small)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,128px);gap:var(--space-6)}
.grid .cover{width:128px;height:178px;font-size:15px}.grid .t{margin-top:6px;font-size:var(--fs-small)}.grid .s{font-size:var(--fs-caption);color:var(--text-3)}
.pdf{background:#fff!important;border:1px solid var(--border)}
.tb{position:fixed;right:16px;top:16px;display:flex;gap:6px}.tb a{padding:6px 10px;border-radius:var(--radius-pill);background:rgba(0,0,0,.45);color:#fff;font-size:12px;text-decoration:none}
`

const ic = {
  books: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 4v16M8 4v16M12 5l4 15M17 4l3 16"/></svg>',
  paper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M9 12h6M9 16h6"/></svg>',
  src: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 20V10M10 20V4M15 20v-7M20 20H3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  logo: '<svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M3 5c3-1 6-1 8 1v14c-2-2-5-2-8-1zM21 5c-3-1-6-1-8 1v14c2-2 5-2 8-1z"/></svg>',
  side: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
}
const ctl = `<div class="ctl"><button aria-label="最小化"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor"/></svg></button><button aria-label="最大化"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/></svg></button><button class="x" aria-label="关闭"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0 0 10" stroke="currentColor"/></svg></button></div>`
const nav = (cls = '') => `<nav class="nav ${cls}"><a class="on" href="#">${ic.books}<span>藏书</span></a><a href="#">${ic.paper}<span>论文</span></a><a href="#">${ic.src}<span>书源</span></a><a href="#">${ic.log}<span>阅读记录</span></a></nav>`
const settings = `<nav class="nav"><a href="#">${ic.gear}<span>设置</span></a></nav>`
const logo = `<div class="logo"><i>${ic.logo}</i><span>轻阅</span></div>`
const search = (w = 280) => `<div class="search" style="width:${w}px">${ic.search}<span>搜索书名 / 作者 / 标签</span></div>`
const add = `<div class="add"><span>＋ 添加书籍</span><b>▾</b></div>`
const body = `<div class="cont"><div class="cover">呐喊</div><div class="meta"><div class="k">继续阅读 · 24 分钟前</div><h3>呐喊</h3><div class="au">鲁迅</div><div class="bar"><i></i><span class="k">1%</span><button class="go">继续</button></div></div>
<div class="stats"><div><b>68</b><small> / 30 分钟</small><div>今日</div></div><div><b>1.1</b><small> 小时</small><div style="color:var(--text-3)">本周</div></div></div></div>
<div class="lh"><b>全部藏书</b><span class="n">3</span><span class="sp"></span><span class="chip">最近阅读 ▾</span><span class="chip">管理</span></div>
<div class="grid"><div><div class="cover">呐喊</div><div class="t">呐喊</div><div class="s">1% · 鲁迅</div></div><div><div class="cover" style="background:#c5d9e6;color:#2f4656">The Republic</div><div class="t">The Republic</div><div class="s">未读 · Plato</div></div><div><div class="cover pdf" style="color:#333;font-size:9px">Attention Is All You Need</div><div class="t">Attention Is All You Need</div><div class="s">PDF · Vaswani</div></div></div>`

const page = (name, desc, css, html) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${name}</title><style>${tokens}${css}</style></head>
<body><div class="tb"><a href="index.html">返回对比</a><a href="#" onclick="document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'':'dark';return false">切换深色</a></div>
<!-- ${desc} -->${html}</body></html>`

const files = {
  '0-现状.html': page('现状', '当前 r2 版本: 独立白色标题条 + 居中重复品牌名, 侧栏从标题条下开始, 白底侧栏与主区靠一条细线分开', `
.tbar{height:40px;display:flex;align-items:center;background:var(--card);border-bottom:1px solid var(--border)}.tbar .t{flex:1;text-align:center;font-size:var(--fs-small);color:var(--text-2);padding-left:138px}
.row{flex:1;display:flex;min-height:0}.side{width:208px;background:var(--card);border-right:1px solid var(--border);padding:18px 12px 16px;display:flex;flex-direction:column;gap:var(--space-4)}
.side .logo{font-size:var(--fs-title);padding:0 var(--space-2) var(--space-2)}.side .logo i{width:30px;height:30px}.side .sp{flex:1}
.nav a.on{background:var(--brand-light);color:var(--brand);font-weight:var(--fw-semibold)}
main{flex:1;overflow:hidden;padding:32px 40px}.ph{display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-6)}.ph h1{flex:1;margin:0;font-size:var(--fs-display);font-weight:var(--fw-medium)}
main{box-shadow:inset -12px 0 0 -2px #e9e9e9}`,
  `<div class="win"><div class="tbar"><span class="t">LightRead 轻阅</span>${ctl}</div><div class="row"><aside class="side">${logo}${nav()}<span class="sp"></span>${settings}</aside>
<main><div class="ph"><h1>藏书</h1>${search(320)}${add}</div>${body}</main></div></div>`),

  'A-一体标题栏.html': page('A 一体标题栏', 'Windows 11 设置 / 资源管理器: 标题栏与侧栏同一块浅灰底 (Mica 感), 品牌在左上角只出现一次; 内容区是左上圆角的白色面板嵌在里面; 页面标题行收紧', `
.win{background:var(--chrome)}
.tbar{height:44px;display:flex;align-items:center;padding-left:var(--space-4);gap:var(--space-3)}.tbar .logo{font-size:var(--fs-body)}.tbar .sp{flex:1}
.row{flex:1;display:flex;min-height:0}.side{width:200px;padding:var(--space-1) var(--space-2) var(--space-3);display:flex;flex-direction:column}.side .sp{flex:1}
.nav a{position:relative}.nav a.on{background:var(--card);color:var(--text);font-weight:var(--fw-medium);box-shadow:var(--shadow-1)}
.nav a.on:before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:2px;background:var(--brand)}.nav a.on svg{color:var(--brand)}
main{flex:1;overflow:hidden;background:var(--bg);border-top-left-radius:var(--radius-lg);border:1px solid var(--chrome-line);border-right:0;border-bottom:0;padding:var(--space-5) var(--space-8)}
.ph{display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-5)}.ph h1{flex:1;margin:0;font-size:var(--fs-title);font-weight:var(--fw-semibold)}`,
  `<div class="win"><div class="tbar">${logo}<span class="sp"></span>${ctl}</div><div class="row"><aside class="side">${nav()}<span class="sp"></span>${settings}</aside>
<main><div class="ph"><h1>藏书</h1>${search(300)}${add}</div>${body}</main></div></div>`),

  'B-侧栏到顶.html': page('B 侧栏到顶', 'macOS 访达 / Notion / Linear: 没有标题条, 侧栏直通到顶 (浅灰), 品牌放在侧栏顶部; 主区顶部那一行既是拖动区也是页面标题行, 窗口按钮贴在右上角; 纵向空间最省', `
.win{flex-direction:row}
.side{width:208px;background:var(--chrome);border-right:1px solid var(--chrome-line);padding:0 var(--space-2) var(--space-3);display:flex;flex-direction:column}
.side .top{height:52px;display:flex;align-items:center;padding:0 var(--space-3)}.side .top .sp{flex:1}.side .top button{color:var(--text-3);display:grid;place-items:center;width:28px;height:28px;border-radius:var(--radius-sm)}.side .top button:hover{background:var(--surface-3)}
.side .sp2{flex:1}.nav a.on{background:color-mix(in srgb,var(--text) 8%,transparent);color:var(--text);font-weight:var(--fw-medium)}.nav a.on svg{color:var(--brand)}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.ph{height:52px;display:flex;align-items:center;gap:var(--space-3);padding-left:var(--space-8)}.ph h1{margin:0;font-size:var(--fs-title);font-weight:var(--fw-semibold)}.ph .sp{flex:1}.ph .ctl{height:52px;align-self:flex-start}.ph .ctl button{height:36px}
main{flex:1;overflow:hidden;padding:var(--space-3) var(--space-8)}`,
  `<div class="win"><aside class="side"><div class="top">${logo}<span class="sp"></span><button aria-label="收起侧栏">${ic.side}</button></div>${nav()}<span class="sp2"></span>${settings}</aside>
<div class="main"><div class="ph"><h1>藏书</h1><span class="sp"></span>${search(260)}${add}<span style="width:4px"></span>${ctl}</div><main>${body}</main></div></div>`),

  'C-标题栏搜索.html': page('C 标题栏搜索', 'Outlook / Teams / 资源管理器: 标题栏中间放全局搜索 (藏书·论文·书源一处搜), 品牌在最左; 侧栏紧凑, 与标题栏同色; 页面标题行只剩标题和添加', `
.win{background:var(--chrome)}
.tbar{height:48px;display:grid;grid-template-columns:200px 1fr auto;align-items:center}.tbar .logo{padding-left:var(--space-5);font-size:var(--fs-body)}.tbar .search{justify-self:center;width:420px;background:var(--card);border:1px solid var(--chrome-line)}
.row{flex:1;display:flex;min-height:0}.side{width:200px;padding:var(--space-1) var(--space-2) var(--space-3);display:flex;flex-direction:column}.side .sp{flex:1}
.nav a.on{background:var(--brand-soft);color:var(--brand);font-weight:var(--fw-medium)}
main{flex:1;overflow:hidden;background:var(--bg);border-top-left-radius:var(--radius-lg);border:1px solid var(--chrome-line);border-right:0;border-bottom:0;padding:var(--space-5) var(--space-8)}
.ph{display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-5)}.ph h1{flex:1;margin:0;font-size:var(--fs-title);font-weight:var(--fw-semibold)}`,
  `<div class="win"><div class="tbar">${logo}${search()}${ctl}</div><div class="row"><aside class="side">${nav()}<span class="sp"></span>${settings}</aside>
<main><div class="ph"><h1>藏书</h1>${add}</div>${body}</main></div></div>`),
}
const index = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Windows 外壳原型</title><style>body{font-family:system-ui,'Microsoft YaHei UI',sans-serif;margin:24px;background:#f4f5f7;color:#222}
.g{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}figure{margin:0;background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}img{width:100%;border-radius:6px;display:block}figcaption{margin-top:8px;font-size:14px;line-height:1.6}a{color:#0066cf}</style></head><body>
<h2>Windows 窗口外壳: 标题栏 + 左侧栏 + 上半部</h2><p>视口 1177×625 (Win10 1080p·150% 实际大小)。点标题打开可交互原型 (右上角可切深色)。推荐 <b>B 侧栏到顶</b>。</p><div class="g">
${Object.keys(files).map(f => `<figure><a href="${f}"><img src="shots/${f.replace('.html', '.png')}" alt="${f}"></a><figcaption><a href="${f}"><b>${f.replace('.html', '')}</b></a><br>${files[f].match(/<!-- (.*?) -->/)[1]}</figcaption></figure>`).join('\n')}
</div></body></html>`
for (const [f, html] of Object.entries(files)) await writeFile(new URL(f, import.meta.url), html)
await writeFile(new URL('index.html', import.meta.url), index)
console.log('ok', Object.keys(files).length)
