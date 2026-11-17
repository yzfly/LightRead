#!/usr/bin/env node
/**
 * 重新生成 src-tauri/vendor/llama-cpp-sys-2: crates.io 上的 llama-cpp-sys-2 原样解包 + 本地补丁。
 *
 * 为什么要自己放一份: 轻量翻译模型 (Hy-MT2 1.8B 1.25bit) 用的 STQ1_0 量化还没进 llama.cpp 正式版
 * (ggml-org/llama.cpp PR #22836), 只能给绑定的 llama.cpp 打上这个补丁 (src-tauri/vendor/patches/)。
 * 见 docs/local-models.md「轻量翻译模型」。
 *
 * 升级 llama-cpp-2 / llama-cpp-sys-2 时: 改下面的版本与摘要 (crates.io 上 .crate 文件的 SHA-256,
 * 即 Cargo.lock 里的 checksum), 重跑本脚本; 补丁打不上就按 PR 的最新版重新做一份。
 * PR 合并进正式版之后, 删掉这份副本和 Cargo.toml 里的 [patch], 直接用 crates.io 的版本。
 *
 * 用法: node scripts/vendor-llama-cpp-sys.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.1.161'
const SHA256 = 'e9bea77fde41bbc15a278891cd5edd2ba07c5260d162614b41080ba1f100b39b'
const PATCHES = ['llama-cpp-stq1_0.patch']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'src-tauri/vendor')
const dest = join(vendor, 'llama-cpp-sys-2')

const url = `https://static.crates.io/crates/llama-cpp-sys-2/llama-cpp-sys-2-${VERSION}.crate`
console.log(`下载 ${url}`)
const res = await fetch(url)
if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`)
const bytes = Buffer.from(await res.arrayBuffer())
const got = createHash('sha256').update(bytes).digest('hex')
if (got !== SHA256) throw new Error(`摘要不符: ${got}, 应为 ${SHA256}`)

const tmp = mkdtempSync(join(tmpdir(), 'llama-cpp-sys-'))
try {
  const archive = join(tmp, 'crate.tar.gz')
  writeFileSync(archive, bytes)
  execFileSync('tar', ['xzf', archive, '-C', tmp])
  const unpacked = join(tmp, `llama-cpp-sys-2-${VERSION}`)
  for (const name of PATCHES) {
    const patch = join(vendor, 'patches', name)
    console.log(`打补丁 ${name}`)
    // --directory 相对于 git 仓库根; 这里在解包目录里单独执行, 不依赖外层仓库
    execFileSync('git', ['apply', '--unsafe-paths', `--directory=llama.cpp`, patch], { cwd: unpacked, stdio: 'inherit' })
  }
  if (existsSync(dest)) rmSync(dest, { recursive: true })
  renameSync(unpacked, dest)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
const lines = readFileSync(join(dest, 'llama.cpp/ggml/include/ggml.h'), 'utf8').split('\n')
if (!lines.some(l => l.includes('GGML_TYPE_STQ1_0'))) throw new Error('补丁没有生效')
console.log(`完成: ${dest}`)
