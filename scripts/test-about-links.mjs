/**
 * 关于页全平台下载 + 读者群 (src/services/aboutLinks.ts): 两条版本线各取最新、镜像只认已校验版本、
 * 不信任外部地址、二维码过期即不显示。
 *
 *   npm run test:about-links
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTHOR_WECHAT, COMMUNITY_BASE, detectPlatform, parseCommunity, parsePlatformReleases, parseWechatContact } from '../src/services/aboutLinks.ts'

const GH = 'https://github.com/yzfly/LightRead/releases/download/'
const gh = (tag, names, extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  ...extra,
  assets: names.map(name => ({ name, size: 10 * 1048576, browser_download_url: `${GH}${tag}/${name}` })),
})
const desktop = v => [`LightRead-${v}-1.x86_64.rpm`, `LightRead_${v}_aarch64.dmg`, `LightRead_${v}_amd64.AppImage`, `LightRead_${v}_amd64.deb`, `LightRead_${v}_x64-setup.exe`, `LightRead_${v}_x64.dmg`, 'LightRead_aarch64.app.tar.gz', 'SHA256SUMS']
const apk = tag => [`LightRead_${tag}_android_arm64.apk`, `LightRead_${tag}_android_arm64.apk.json`, 'SHA256SUMS']

test('desktop and app lines each pick their newest release', () => {
  const list = [
    gh('v2.3.1', desktop('2.3.1')),
    gh('app-v2.3.0', apk('app-v2.3.0')),
    gh('v2.3.0', desktop('2.3.0')),
    gh('v2.2.5', [...desktop('2.2.5'), ...apk('v2.2.5')]),
    gh('v1.20.1', apk('v1.20.1')),
  ]
  const items = parsePlatformReleases(list, 'github')
  assert.deepEqual(items.map(i => [i.platform, i.version]), [['windows', '2.3.1'], ['mac', '2.3.1'], ['linux', '2.3.1'], ['android', '2.3.0']])
  assert.deepEqual(items.find(i => i.platform === 'mac').packages.map(p => p.kind), ['appleSilicon', 'intel'])
  assert.deepEqual(items.find(i => i.platform === 'linux').packages.map(p => p.kind), ['appimage', 'deb', 'rpm'])
  const android = items.find(i => i.platform === 'android').packages
  assert.equal(android.length, 1)
  assert.equal(android[0].url, `${GH}app-v2.3.0/LightRead_app-v2.3.0_android_arm64.apk`)
  assert.equal(android[0].size, 10 * 1048576)
})

test('an older unified release still supplies the APK when no app-v release exists', () => {
  const items = parsePlatformReleases([gh('v2.3.1', desktop('2.3.1')), gh('v2.2.5', [...desktop('2.2.5'), ...apk('v2.2.5')])], 'github')
  assert.equal(items.find(i => i.platform === 'android').version, '2.2.5')
})

test('app-v tags never supply desktop installers', () => {
  const items = parsePlatformReleases([gh('app-v9.0.0', [...desktop('9.0.0'), ...apk('app-v9.0.0')]), gh('v2.3.1', desktop('2.3.1'))], 'github')
  assert.equal(items.find(i => i.platform === 'windows').version, '2.3.1')
  assert.equal(items.find(i => i.platform === 'android').version, '9.0.0')
})

test('drafts, prereleases, odd tags and foreign URLs are ignored', () => {
  const evil = gh('v3.0.0', desktop('3.0.0'))
  evil.assets = evil.assets.map(a => ({ ...a, browser_download_url: `https://evil.example/${a.name}` }))
  const items = parsePlatformReleases([
    gh('v9.0.0', desktop('9.0.0'), { draft: true }),
    gh('v8.0.0', desktop('8.0.0'), { prerelease: true }),
    gh('v7.0.0-beta', desktop('7.0.0')),
    evil,
    gh('v2.3.1', desktop('2.3.1')),
  ], 'github')
  assert.ok(items.every(i => i.version === '2.3.1'))
  assert.equal(parsePlatformReleases(null, 'github').length, 0)
})

test('iOS: unsigned IPA is listed from the app line only when a release carries it', () => {
  const ipa = 'LightRead_app-v2.4.0_ios_unsigned.ipa'
  const without = parsePlatformReleases([gh('v2.3.1', desktop('2.3.1')), gh('app-v2.3.0', apk('app-v2.3.0'))], 'github')
  assert.equal(without.find(i => i.platform === 'ios'), undefined)
  const items = parsePlatformReleases([
    gh('v2.3.1', desktop('2.3.1')),
    gh('app-v2.4.0', [...apk('app-v2.4.0'), ipa]),
    gh('app-v2.3.0', apk('app-v2.3.0')),
  ], 'github')
  assert.deepEqual(items.map(i => i.platform), ['windows', 'mac', 'linux', 'android', 'ios'])
  const ios = items.find(i => i.platform === 'ios')
  assert.equal(ios.version, '2.4.0')
  assert.deepEqual(ios.packages.map(p => [p.kind, p.url]), [['ipa', `${GH}app-v2.4.0/${ipa}`]])
})

test('GitCode: only mirrored (SHA256SUMS) releases, URLs rebuilt, sizes from the body note', () => {
  const sizes = { 'LightRead_2.3.1_x64-setup.exe': 9 * 1048576 }
  const list = [
    { tag_name: 'v2.4.0', assets: desktop('2.4.0').filter(n => n !== 'SHA256SUMS').map(name => ({ name })) },
    { tag_name: 'v2.3.1', body: `notes\n<!-- lightread-mirror-sizes ${JSON.stringify(sizes)} -->`, assets: [...desktop('2.3.1').map(name => ({ name, browser_download_url: 'https://evil.example/x' })), { name: 'src.zip', type: 'source' }] },
    { tag_name: 'app-v2.3.0', assets: apk('app-v2.3.0').map(name => ({ name })) },
  ]
  const items = parsePlatformReleases(list, 'gitcode')
  const win = items.find(i => i.platform === 'windows')
  assert.equal(win.version, '2.3.1')
  assert.equal(win.packages[0].url, 'https://gitcode.com/langgpt/LightRead/releases/download/v2.3.1/LightRead_2.3.1_x64-setup.exe')
  assert.equal(win.packages[0].size, 9 * 1048576)
  assert.equal(items.find(i => i.platform === 'mac').packages[0].size, 0)
  assert.equal(items.find(i => i.platform === 'android').version, '2.3.0')
})

test('detectPlatform marks this device; iOS has no package', () => {
  assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 12; K30) AppleWebKit'), 'android')
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac')
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows')
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux')
  assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), null)
})

test('community: valid until expiry, only images under the community directory', () => {
  const now = Date.parse('2026-10-27T12:00:00+08:00')
  const ok = { wechatGroup: { name: 'LightRead 读者群', image: `${COMMUNITY_BASE}wechat-group-1a2b3c4d.png`, expiresAt: '2026-11-03T00:00:00+08:00' } }
  assert.deepEqual(parseCommunity(ok, now), ok.wechatGroup)
  assert.equal(parseCommunity(ok, Date.parse('2026-11-03T00:00:00+08:00')), null)
  assert.equal(parseCommunity({ wechatGroup: { ...ok.wechatGroup, image: 'https://evil.example/qr.png' } }, now), null)
  assert.equal(parseCommunity({ wechatGroup: { ...ok.wechatGroup, image: `${COMMUNITY_BASE}../x.png`.replace('..', 'a/..') } }, now), null)
  assert.equal(parseCommunity({ wechatGroup: { ...ok.wechatGroup, expiresAt: 'soon' } }, now), null)
  assert.equal(parseCommunity({ wechatGroup: { ...ok.wechatGroup, name: ' ' } }, now), null)
  assert.equal(parseCommunity(null, now), null)
})

test('author WeChat: bundled default, remote override only when well-formed', () => {
  assert.equal(AUTHOR_WECHAT, '1796060717')
  assert.equal(parseWechatContact(null), AUTHOR_WECHAT)
  assert.equal(parseWechatContact({}), AUTHOR_WECHAT)
  assert.equal(parseWechatContact({ wechatContact: { id: ' lightread_cn ' } }), 'lightread_cn')
  for (const bad of ['', 'a b c d e', 'x', '<script>', 'https://evil.example', 'a'.repeat(40)]) {
    assert.equal(parseWechatContact({ wechatContact: { id: bad } }), AUTHOR_WECHAT, bad)
  }
})
