#!/usr/bin/env node
// iOS 包的唯一入口 (只能在装了 Xcode 的 Mac 上跑):
//   npm run ios:sim   模拟器包      node scripts/build-ios.mjs [--driver http://127.0.0.1:4599] [--fresh]
//   npm run ios:ipa   未签名真机包  node scripts/build-ios.mjs --ipa [--fresh]
//   npm run ios:appstore  TestFlight / App Store 包  node scripts/build-ios.mjs --app-store [--upload] [--fresh]
//  - gen/apple 不入库: 不存在或带 --fresh 时重新 `tauri ios init` (最低系统版本等取自 tauri.ios.conf.json);
//  - Info.plist 的 iOS 专属条目在 src-tauri/Info.ios.plist, 原生壳在 src-tauri/plugins/ios-shell, 都由 Tauri 自动并入;
//  - --driver 把模拟器验收的遥控通道打进包 (docs/testing/ios-simulator.md), 只用于验收, 不能用于发布;
//  - 模拟器包与未签名 IPA 不需要签名。未签名 IPA 装不进没越狱的手机, 要由使用者自己重签
//    (AltStore / Sideloadly 等, 免费 Apple ID 每 7 天重签一次)。
//  - --app-store: 用 Apple Distribution 证书 + 「LightRead App Store」描述文件手动签名 (MacAir 的签名钥匙串,
//    调用前先解锁, 见 jiangshu-infra reports/macos-signing.md); --upload 再用 APPLE_API_* 的 App Store Connect
//    密钥传到 TestFlight。同一个版本号只能上传一次。
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'darwin') throw new Error('iOS 构建只能在 macOS 上进行')
const args = process.argv.slice(2)
const driver = args.includes('--driver') ? args[args.indexOf('--driver') + 1] : ''
const ipa = args.includes('--ipa')
const appStore = args.includes('--app-store')
const upload = args.includes('--upload')
if (ipa && appStore) throw new Error('--ipa 与 --app-store 只能选一个')
if (upload && !appStore) throw new Error('--upload 只用于 --app-store')
if ((ipa || appStore) && driver) throw new Error('真机包不能带遥控通道 (--driver 只用于模拟器验收)')
const TEAM = process.env.IOS_TEAM_ID || '3HNKBKJ59V'
const PROFILE = process.env.IOS_PROFILE_NAME || 'LightRead App Store'
const BUNDLE_ID = 'com.yzfly.lightread'
const env = { ...process.env }
if (driver) env.LIGHTREAD_E2E_DRIVER = driver
else delete env.LIGHTREAD_E2E_DRIVER

// Tauri CLI 调 xcodebuild 时不透传环境变量, 只设环境变量不够: 用同名包装脚本带进去。
//  - xcode-select 仍指向命令行工具时 (切换需要管理员密码), 把构建指到 Xcode;
//  - 未签名真机包用 xcconfig 关掉签名 (见下)。
const xcode = '/Applications/Xcode.app/Contents/Developer'
const selected = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim()
const exported = {}
if (!selected.includes('.app/') && existsSync(xcode)) exported.DEVELOPER_DIR = xcode
if (ipa) {
  exported.XCODE_XCCONFIG_FILE = join(tmpdir(), 'lightread-ios-unsigned.xcconfig')
  writeFileSync(exported.XCODE_XCCONFIG_FILE, 'CODE_SIGNING_ALLOWED = NO\nCODE_SIGNING_REQUIRED = NO\nCODE_SIGN_IDENTITY =\nCODE_SIGN_STYLE = Manual\nCODE_SIGN_ENTITLEMENTS =\nDEVELOPMENT_TEAM =\nPROVISIONING_PROFILE_SPECIFIER =\n')
}
if (appStore) {
  if (upload && !['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH'].every(k => env[k])) throw new Error('--upload 需要 APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_PATH')
  // 手动签名: 不依赖 Xcode 里登录的 Apple ID
  exported.XCODE_XCCONFIG_FILE = join(tmpdir(), 'lightread-ios-appstore.xcconfig')
  writeFileSync(exported.XCODE_XCCONFIG_FILE, `CODE_SIGN_STYLE = Manual\nDEVELOPMENT_TEAM = ${TEAM}\nCODE_SIGN_IDENTITY = Apple Distribution\nPROVISIONING_PROFILE_SPECIFIER = ${PROFILE}\n`)
  env.APPLE_DEVELOPMENT_TEAM = TEAM
}
if (Object.keys(exported).length) {
  const dir = join(tmpdir(), 'lightread-xcode-tools')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const exports = Object.entries(exported).map(([key, value]) => `export ${key}='${value}'\n`).join('')
  for (const tool of ['xcodebuild', 'xcrun', 'xcode-select']) {
    writeFileSync(join(dir, tool), `#!/bin/sh\n${exports}exec /usr/bin/${tool} "$@"\n`)
    chmodSync(join(dir, tool), 0o755)
  }
  Object.assign(env, exported)
  env.PATH = `${dir}:${env.PATH}`
}

const run = (cmd, argv) => execFileSync(cmd, argv, { env, stdio: 'inherit' })
const project = 'src-tauri/gen/apple'
if (args.includes('--fresh')) rmSync(project, { recursive: true, force: true })
if (!existsSync(project)) run('npx', ['tauri', 'ios', 'init'])
if (appStore) {
  // Tauri 的导出一步按自动签名生成 ExportOptions, 与手动签名对不上; 只借它构建与归档, 导出自己做。
  const archive = join(project, 'build/lightread_iOS.xcarchive')
  rmSync(archive, { recursive: true, force: true })
  try {
    run('npx', ['tauri', 'ios', 'build', '--target', 'aarch64', '--ci', '--export-method', 'app-store-connect'])
  } catch (error) {
    if (!existsSync(join(archive, 'Products/Applications/LightRead.app'))) throw error
    console.log('\n(Tauri 的导出失败不影响: 归档已生成, 下面用手动签名的导出选项重新导出)')
  }
  const version = JSON.parse(readFileSync('src-tauri/tauri.ios.conf.json', 'utf8')).version
  const options = (destination) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>${destination}</string>
<key>teamID</key><string>${TEAM}</string>
<key>signingStyle</key><string>manual</string>
<key>signingCertificate</key><string>Apple Distribution</string>
<key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${PROFILE}</string></dict>
<key>uploadSymbols</key><true/>
<key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
`
  const exportTo = (destination, dir) => {
    const plist = join(tmpdir(), `lightread-ios-export-${destination}.plist`)
    writeFileSync(plist, options(destination))
    rmSync(dir, { recursive: true, force: true })
    const auth = destination === 'upload'
      ? ['-authenticationKeyPath', env.APPLE_API_KEY_PATH, '-authenticationKeyID', env.APPLE_API_KEY, '-authenticationKeyIssuerID', env.APPLE_API_ISSUER]
      : []
    run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportPath', dir, '-exportOptionsPlist', plist, ...auth])
  }
  const outDir = join(project, 'build/appstore')
  exportTo('export', outDir)
  const out = join(process.cwd(), project, `build/LightRead_app-v${version}_ios_appstore.ipa`)
  rmSync(out, { force: true })
  cpSync(join(outDir, 'LightRead.ipa'), out)
  console.log(`\n${out}  (${(statSync(out).size / 1048576).toFixed(1)} MB, App Store 签名)`)
  if (upload) {
    exportTo('upload', join(project, 'build/appstore-upload'))
    console.log('已上传到 App Store Connect, 处理完成后出现在 TestFlight')
  }
  process.exit(0)
}
if (ipa) {
  // Tauri 的真机构建固定走 build → archive → 签名导出。上面的 xcconfig 关掉签名让前两步通过,
  // 导出一步必然失败 (没有证书), 从归档里取出 .app 自己装成 IPA。
  const archive = join(project, 'build/lightread_iOS.xcarchive')
  rmSync(archive, { recursive: true, force: true })
  try {
    run('npx', ['tauri', 'ios', 'build', '--target', 'aarch64', '--ci'])
  } catch (error) {
    if (!existsSync(join(archive, 'Products/Applications/LightRead.app'))) throw error
    console.log('\n(签名导出失败属预期: 没有证书。继续打未签名 IPA)')
  }
  const version = JSON.parse(readFileSync('src-tauri/tauri.ios.conf.json', 'utf8')).version
  const stage = join(tmpdir(), 'lightread-ios-ipa')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, 'Payload'), { recursive: true })
  cpSync(join(archive, 'Products/Applications/LightRead.app'), join(stage, 'Payload/LightRead.app'), { recursive: true, verbatimSymlinks: true })
  const out = join(process.cwd(), project, `build/LightRead_app-v${version}_ios_unsigned.ipa`)
  rmSync(out, { force: true })
  execFileSync('zip', ['-qry', out, 'Payload'], { cwd: stage, stdio: 'inherit' })
  rmSync(stage, { recursive: true, force: true })
  console.log(`\n${out}  (${(statSync(out).size / 1048576).toFixed(1)} MB, 未签名)`)
  process.exit(0)
}
// Tauri 把产物改名到 build/arm64-sim, 目标已存在时会报 "Directory not empty"
rmSync(join(project, 'build/arm64-sim'), { recursive: true, force: true })
run('npx', ['tauri', 'ios', 'build', '--debug', '--target', 'aarch64-sim', '--ci'])
console.log(`\n${project}/build/arm64-sim/LightRead.app${driver ? `  (含遥控通道 ${driver}, 仅供验收)` : ''}`)
