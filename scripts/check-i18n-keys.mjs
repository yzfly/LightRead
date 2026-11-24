#!/usr/bin/env node
/**
 * 界面文案的 key 两套字典都要有: App 构建按 src/mobile/overrides.json 把 i18n/zh.ts、en.ts 换成 src/mobile/i18n 下的那份,
 * 共享代码 (组件、服务) 里新加的 t('...') 只写进桌面字典时, App 上会直接显示 key。
 * 规则: 共享文件 → 桌面与 App 字典都要有; src/mobile 下 → App 字典; 被 App 覆盖的桌面文件 → 桌面字典。只查字面量 key。
 * 棘轮: 已有的缺口 (多是 App 不会加载的桌面专属组件) 记在 i18n-keys-baseline.json, 只许减少; 新增缺口直接失败。
 *   node scripts/check-i18n-keys.mjs --update   # 补齐一批后写回更小的基线
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')
const overrides = new Set(JSON.parse(readFileSync(join(src, 'mobile/overrides.json'), 'utf8')))

// 字典条目: 'a.b': … 或 "a.b": … (一行可有多条)
const keysIn = text => [...text.matchAll(/(?:^|[{,])\s*(['"])([a-zA-Z][\w-]*\.[\w.-]+)\1\s*:/gm)].map(m => m[2])
const dictKeys = file => new Set(keysIn(readFileSync(join(src, file), 'utf8')))
const extra = keysIn(readFileSync(join(src, 'i18n/libraryUpload.ts'), 'utf8'))
const dicts = {
  desktop: { zh: dictKeys('i18n/zh.ts'), en: dictKeys('i18n/en.ts') },
  mobile: { zh: dictKeys('mobile/i18n/zh.ts'), en: dictKeys('mobile/i18n/en.ts') },
}
for (const d of Object.values(dicts)) for (const k of extra) { d.zh.add(k); d.en.add(k) }

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) { if (name !== 'vendor') yield* files(path) }
    else if (/\.(ts|vue)$/.test(name) && !/^i18n\//.test(relative(src, path)) && !/^mobile\/i18n\//.test(relative(src, path))) yield path
  }
}

const missing = []
for (const path of files(src)) {
  const rel = relative(src, path)
  const targets = rel.startsWith('mobile/') ? ['mobile'] : overrides.has(rel) ? ['desktop'] : ['desktop', 'mobile']
  const text = readFileSync(path, 'utf8')
  for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z][\w-]*\.[\w.-]*[\w-])'/g)) {
    for (const target of targets) {
      for (const lang of ['zh', 'en']) {
        if (!dicts[target][lang].has(m[1])) missing.push(`${rel}: ${m[1]} 不在${target === 'mobile' ? ' App ' : '桌面'}字典 (${lang})`)
      }
    }
  }
}
const unique = [...new Set(missing)].sort()
const BASELINE = join(root, 'scripts/i18n-keys-baseline.json')
if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(unique, null, 1) + '\n')
  console.log(`基线已写入: ${unique.length} 处`)
  process.exit(0)
}
const known = new Set(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : [])
const added = unique.filter(line => !known.has(line))
const fixed = [...known].filter(line => !unique.includes(line))
if (added.length) {
  console.error(added.join('\n'))
  console.error(`\n${added.length} 处新的文案 key 缺字典。App 构建用 src/mobile/i18n/zh.ts、en.ts, 共享组件的文案两套都要加`)
  process.exit(1)
}
if (fixed.length) console.log(`已补齐 ${fixed.length} 处, 可运行 --update 缩小基线`)
console.log(`i18n keys ok (基线 ${known.size} 处)`)
