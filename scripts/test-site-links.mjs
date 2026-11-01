// 应用内官网链接与站点构建的路径一致 (src/services/siteLinks.ts ↔ scripts/build-site.mjs)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/services/siteLinks.ts', import.meta.url), 'utf8')
const build = readFileSync(new URL('./build-site.mjs', import.meta.url), 'utf8')

test('每个应用内映射都对应 build-site.mjs 生成的页面', () => {
  const app = [...src.matchAll(/'(docs\/[^']+\.md)': '([^']*)'/g)].map(m => [m[1], m[2]])
  const site = new Map([...build.matchAll(/src: '([^']+)', out: '([^']+)'/g)].map(m => [m[1], m[2].replace(/index\.html$/, '')]))
  assert.ok(app.length >= 10)
  assert.equal(app.length, site.size)
  for (const [repo, page] of app) assert.equal(site.get(repo), page, repo)
})

test('站点地址一致', () => {
  assert.match(src, /SITE_URL = 'https:\/\/code\.jiangshu\.ai\/LightRead\/'/)
  assert.match(build, /SITE = 'https:\/\/code\.jiangshu\.ai\/LightRead\/'/)
})
