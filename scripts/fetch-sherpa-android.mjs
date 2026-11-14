#!/usr/bin/env node
// Android 离线语音 (src-tauri/src/local_tts.rs) 用的 sherpa-onnx 预编译动态库。
// Rust 的 sherpa-onnx-sys 只会给桌面平台下载预编译库; Android 由这里取上游 Release 里的
// sherpa-onnx-v<版本>-android.tar.bz2, 只解出 arm64-v8a 的两个库 (C 接口 + onnxruntime):
//   - 构建时经 SHERPA_ONNX_LIB_DIR 交给 sherpa-onnx-sys 链接 (features = ["shared"]);
//   - npm run android:build 再把它们放进 APK 的 jniLibs, 与 liblightread_lib.so 一起加载。
// 版本必须与 Cargo.lock 里的 sherpa-onnx 一致 (C 接口随版本变); 压缩包与两个库都按固定的 SHA-256 校验。
// 两个库都按 16KB 页对齐、不带调试段、不依赖 libc++_shared.so (2026-11-14 核对)。
//
//   node scripts/fetch-sherpa-android.mjs            # 打印库所在目录
//   SHERPA_ONNX_ANDROID_ARCHIVE=<本地压缩包> …        # GitHub 连不上的机器: 先在别处下载好
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SHERPA_ANDROID = {
  version: '1.13.3',
  archiveSha256: '04acacdb5eaa41d814e7792e7906168d147af6023faa9e9caf38b2f321b4cf52',
  libs: {
    'libsherpa-onnx-c-api.so': 'aac6f369f1985c96c788e8e64883ecc3bc9915bbc158ec86eb998946f0449ddd',
    'libonnxruntime.so': '4d2318b3849abb8862133d3068fc7e807ed8b2671cc6d83657fff2fcb9e1caad',
  },
}
const ABI = 'arm64-v8a'

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function lockedVersion() {
  const lock = readFileSync(fileURLToPath(new URL('../src-tauri/Cargo.lock', import.meta.url)), 'utf8')
  return lock.match(/name = "sherpa-onnx"\nversion = "([^"]+)"/)?.[1] ?? ''
}

function verified(dir) {
  return Object.entries(SHERPA_ANDROID.libs).every(([name, sum]) => existsSync(join(dir, name)) && sha256(join(dir, name)) === sum)
}

/** 确保两个库在本机缓存里 (没有就下载、校验、解包), 返回所在目录 */
export async function ensureSherpaAndroid() {
  const { version, archiveSha256 } = SHERPA_ANDROID
  const locked = lockedVersion()
  if (locked !== version) throw new Error(`Cargo.lock 里的 sherpa-onnx 是 ${locked || '?'}, 而 Android 预编译库是 ${version}: 同步更新 scripts/fetch-sherpa-android.mjs 的版本与摘要`)
  const root = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'lightread/sherpa-onnx-android', `v${version}`)
  const dir = join(root, ABI)
  if (verified(dir)) return dir

  mkdirSync(root, { recursive: true })
  const name = `sherpa-onnx-v${version}-android.tar.bz2`
  let archive = process.env.SHERPA_ONNX_ANDROID_ARCHIVE || join(root, name)
  if (!existsSync(archive)) {
    const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${version}/${name}`
    console.log(`下载 ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}\n可先在别处下载, 再用 SHERPA_ONNX_ANDROID_ARCHIVE 指向它`)
    writeFileSync(`${archive}.part`, Buffer.from(await res.arrayBuffer()))
    renameSync(`${archive}.part`, archive)
  }
  const got = sha256(archive)
  if (got !== archiveSha256) throw new Error(`${archive} 的 SHA-256 不对: ${got}`)

  const stage = join(root, 'extract')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  execFileSync('tar', ['-xjf', archive, '-C', stage, ...Object.keys(SHERPA_ANDROID.libs).map(lib => `./jniLibs/${ABI}/${lib}`)], { stdio: 'inherit' })
  mkdirSync(dir, { recursive: true })
  for (const lib of Object.keys(SHERPA_ANDROID.libs)) copyFileSync(join(stage, 'jniLibs', ABI, lib), join(dir, lib))
  rmSync(stage, { recursive: true, force: true })
  if (!verified(dir)) throw new Error(`解出的库与记录的 SHA-256 不一致: ${dir}`)
  return dir
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await ensureSherpaAndroid())
