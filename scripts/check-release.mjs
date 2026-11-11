import assert from 'node:assert/strict'
import { verifyApkLayout, verifyNativeLibraries } from './apk-layout.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'

// Existing experimental Android installs must remain upgrade-compatible.
const ANDROID_PACKAGE = 'com.yzfly.lightread.debug'
const ANDROID_MIN_SDK = 24
const ANDROID_TARGET_SDK = 36

function validateVersions(versions, tag) {
  const version = versions['package.json']
  assert.match(version, /^\d+\.\d+\.\d+$/, 'release version must be X.Y.Z')
  for (const [file, actual] of Object.entries(versions)) {
    assert.equal(actual, version, `${file} version does not match package.json`)
  }
  if (tag) assert.equal(tag, `v${version}`, 'release tag does not match package.json')
  return version
}

function repositoryVersion(tag, platform = 'desktop') {
  const json = file => JSON.parse(readFileSync(file, 'utf8'))
  const pkg = json('package.json')
  const lock = json('package-lock.json')
  const config = json('src-tauri/tauri.conf.json')
  const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0]
  const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8').split('[[package]]')
    .find(section => /^name = "lightread"$/m.test(section))
  const tomlVersion = text => text?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  assert.equal(config.identifier, 'com.yzfly.lightread', 'application identifier must remain stable')
  assert.equal(config.bundle?.android?.debugApplicationIdSuffix, '.debug', 'Android package suffix must remain stable')
  assert.ok(!config.bundle?.android?.autoIncrementVersionCode, 'release versionCode must be reproducible')
  const desktopVersion = validateVersions({
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json packages root': lock.packages?.['']?.version,
    'src-tauri/Cargo.toml': tomlVersion(cargo),
    'src-tauri/Cargo.lock lightread': tomlVersion(cargoLock),
    'src-tauri/tauri.conf.json': config.version,
  }, platform === 'desktop' ? tag : undefined)
  assert.ok(['desktop', 'android', 'ios'].includes(platform), 'unknown release platform')
  assert.ok(!process.env.LIGHTREAD_E2E_DRIVER, 'LIGHTREAD_E2E_DRIVER must not be set for a release build (it bundles the simulator remote-control channel)')
  let version = desktopVersion
  if (platform !== 'desktop' && existsSync(`src-tauri/tauri.${platform}.conf.json`)) {
    const mobile = json(`src-tauri/tauri.${platform}.conf.json`)
    // iOS 只许声明最低系统版本 (前端构建目标是 iOS 15, Tauri 默认 14) 和文档类型 (iOS 只认类型标识, 桌面那份按扩展名写的不生效);
    // 其余 bundle 字段会改应用身份
    const bundle = platform === 'ios' && mobile.bundle ? { ...mobile.bundle, iOS: { ...mobile.bundle.iOS } } : mobile.bundle
    if (platform === 'ios' && bundle) {
      delete bundle.fileAssociations
      delete bundle.iOS.minimumSystemVersion
      if (!Object.keys(bundle.iOS).length) delete bundle.iOS
    }
    assert.ok(!mobile.identifier && (!bundle || !Object.keys(bundle).length), 'mobile version config must not override application identity')
    version = validateVersions({ 'package.json': mobile.version }, tag?.replace(/^app-/, ''))
  }
  // 桌面与 App 分开发版: 桌面 vX.Y.Z (package.json 等), App app-vX.Y.Z (tauri.<platform>.conf.json)
  if (tag && platform !== 'desktop') assert.match(tag, /^app-v/, 'App releases use app-vX.Y.Z tags')
  if (tag) assert.equal(platform === 'desktop' ? tag : tag.replace(/^app-/, ''), `v${version}`, 'release tag does not match platform version')
  const [major, minor, patch] = version.split('.').map(Number)
  const versionCode = config.bundle?.android?.versionCode ?? major * 1_000_000 + minor * 1_000 + patch
  assert.ok(Number.isSafeInteger(versionCode) && versionCode > 0 && versionCode <= 2_100_000_000, 'invalid Android versionCode')
  return { version, versionCode }
}

function verifyApkMetadata(badging, certificates, expected) {
  const match = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m)
  assert.ok(match, 'aapt did not return APK package metadata')
  const [, packageName, rawCode, versionName] = match
  assert.equal(packageName, ANDROID_PACKAGE, 'APK application ID changed')
  assert.equal(versionName, expected.version, 'APK versionName mismatch')
  assert.equal(Number(rawCode), expected.versionCode, 'APK versionCode mismatch')
  const minSdk = Number(badging.match(/^sdkVersion:'(\d+)'/m)?.[1])
  const targetSdk = Number(badging.match(/^targetSdkVersion:'(\d+)'/m)?.[1])
  assert.equal(minSdk, ANDROID_MIN_SDK, 'APK minimum Android API changed')
  assert.equal(targetSdk, ANDROID_TARGET_SDK, 'APK target Android API changed')
  const abis = [...(badging.match(/^native-code:(.+)$/m)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.deepEqual(abis, ['arm64-v8a'], 'APK must contain exactly the arm64-v8a ABI')
  const fingerprints = [...certificates.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([\da-f:]+)\s*$/gmi)]
    .map(match => match[1].replaceAll(':', '').toLowerCase())
  const expectedCert = expected.cert?.replaceAll(':', '').trim().toLowerCase()
  assert.match(expectedCert ?? '', /^[a-f\d]{64}$/, 'expected Android certificate SHA-256 is required')
  assert.deepEqual(fingerprints, [expectedCert], 'APK signing certificate changed')
  return { packageName, versionName, versionCode: Number(rawCode), minSdk, targetSdk, abis, certificateSha256: fingerprints[0] }
}

function selfTest() {
  assert.equal(validateVersions({ 'package.json': '1.3.0', cargo: '1.3.0' }, 'v1.3.0'), '1.3.0')
  assert.throws(() => validateVersions({ 'package.json': '1.3.0', cargo: '1.2.0' }, 'v1.3.0'))
  assert.throws(() => validateVersions({ 'package.json': '1.3.0' }, 'v1.2.0'))
  const cert = 'ab'.repeat(32)
  const expected = { version: '1.3.0', versionCode: 1003000, cert }
  const badging = "package: name='com.yzfly.lightread.debug' versionCode='1003000' versionName='1.3.0'\nsdkVersion:'24'\ntargetSdkVersion:'36'\nnative-code: 'arm64-v8a'"
  const certificates = `Signer #1 certificate SHA-256 digest: ${cert}`
  assert.equal(verifyApkMetadata(badging, certificates, expected).packageName, ANDROID_PACKAGE)
  for (const [from, to] of [['.debug', ''], ['1003000', '1002000'], ['1.3.0', '1.2.0'], ["sdkVersion:'24'", "sdkVersion:'26'"], ["targetSdkVersion:'36'", "targetSdkVersion:'35'"], ['arm64-v8a', 'x86_64']]) {
    assert.throws(() => verifyApkMetadata(badging.replace(from, to), certificates, expected))
  }
  assert.throws(() => verifyApkMetadata(badging, certificates, { ...expected, cert: 'cd'.repeat(32) }))
  assert.throws(() => verifyApkMetadata(badging, '', expected))
  console.log('Release checks: 12 assertions passed (versions, tag, Android identity, APIs, ABI, certificate).')
}

try {
  const { values } = parseArgs({ options: {
    platform: { type: 'string' }, tag: { type: 'string' }, apk: { type: 'string' }, cert: { type: 'string' }, 'self-test': { type: 'boolean' },
  } })
  if (values['self-test']) {
    selfTest()
  } else {
    const expected = repositoryVersion(values.tag, values.platform ?? (values.apk ? 'android' : 'desktop'))
    console.log(`Version checks passed: ${expected.version}`)
    if (values.apk) {
      const tool = (name, args) => execFileSync(process.env[name.toUpperCase()] || name, args, { encoding: 'utf8' })
      const metadata = verifyApkMetadata(tool('aapt', ['dump', 'badging', values.apk]), tool('apksigner', ['verify', '--verbose', '--print-certs', values.apk]), { ...expected, cert: values.cert })
      const bytes = readFileSync(values.apk)
      const layout = verifyApkLayout(bytes)
      const nativeLibraries = verifyNativeLibraries(bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(`${values.apk}.sha256`, `${sha256}  ${basename(values.apk)}\n`)
      writeFileSync(`${values.apk}.json`, `${JSON.stringify({ file: basename(values.apk), ...metadata, layout, nativeLibraries, sha256 }, null, 2)}\n`)
      console.log(JSON.stringify({ ...metadata, sha256 }, null, 2))
    }
  }
} catch (error) {
  console.error(`Release validation failed: ${error.message}`)
  process.exitCode = 1
}
