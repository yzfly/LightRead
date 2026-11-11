#!/usr/bin/env node
// iOS 模拟器包的唯一入口 (只能在装了 Xcode 的 Mac 上跑): npm run ios:sim
//   node scripts/build-ios.mjs [--driver http://127.0.0.1:4599] [--fresh]
//  - gen/apple 不入库: 不存在或带 --fresh 时重新 `tauri ios init` (最低系统版本等取自 tauri.ios.conf.json);
//  - Info.plist 的 iOS 专属条目在 src-tauri/Info.ios.plist, 原生壳在 src-tauri/plugins/ios-shell, 都由 Tauri 自动并入;
//  - --driver 把模拟器验收的遥控通道打进包 (docs/testing/ios-simulator.md), 只用于验收, 不能用于发布;
//  - 模拟器包不需要签名和开发者账号。真机 / TestFlight 包另见 docs/plans/ios-app.md 阶段 3。
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'darwin') throw new Error('iOS 构建只能在 macOS 上进行')
const args = process.argv.slice(2)
const driver = args.includes('--driver') ? args[args.indexOf('--driver') + 1] : ''
const env = { ...process.env }
if (driver) env.LIGHTREAD_E2E_DRIVER = driver
else delete env.LIGHTREAD_E2E_DRIVER

// xcode-select 仍指向命令行工具时 (切换需要管理员密码), 用同名包装脚本把构建指到 Xcode;
// Tauri CLI 调 xcodebuild 时不带 DEVELOPER_DIR, 只设环境变量不够。
const xcode = '/Applications/Xcode.app/Contents/Developer'
const selected = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim()
if (!selected.includes('.app/') && existsSync(xcode)) {
  const dir = join(tmpdir(), 'lightread-xcode-tools')
  mkdirSync(dir, { recursive: true })
  for (const tool of ['xcodebuild', 'xcrun', 'xcode-select']) {
    writeFileSync(join(dir, tool), `#!/bin/sh\nexport DEVELOPER_DIR=${xcode}\nexec /usr/bin/${tool} "$@"\n`)
    chmodSync(join(dir, tool), 0o755)
  }
  env.DEVELOPER_DIR = xcode
  env.PATH = `${dir}:${env.PATH}`
}

const run = (cmd, argv) => execFileSync(cmd, argv, { env, stdio: 'inherit' })
const project = 'src-tauri/gen/apple'
if (args.includes('--fresh')) rmSync(project, { recursive: true, force: true })
if (!existsSync(project)) run('npx', ['tauri', 'ios', 'init'])
// Tauri 把产物改名到 build/arm64-sim, 目标已存在时会报 "Directory not empty"
rmSync(join(project, 'build/arm64-sim'), { recursive: true, force: true })
run('npx', ['tauri', 'ios', 'build', '--debug', '--target', 'aarch64-sim', '--ci'])
console.log(`\n${project}/build/arm64-sim/LightRead.app${driver ? `  (含遥控通道 ${driver}, 仅供验收)` : ''}`)
