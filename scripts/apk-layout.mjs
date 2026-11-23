import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

function zipEntries(data) {
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { eocd = i; break }
  }
  assert.ok(eocd >= 0, 'APK ZIP directory missing')
  const count = data.readUInt16LE(eocd + 10), central = data.readUInt32LE(eocd + 16)
  assert.ok(count > 0 && count < 65535 && central < eocd, 'unsupported APK ZIP layout')
  const entries = []
  let cursor = central
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50, 'invalid APK central entry')
    const method = data.readUInt16LE(cursor + 10), size = data.readUInt32LE(cursor + 20), local = data.readUInt32LE(cursor + 42)
    const nameLength = data.readUInt16LE(cursor + 28)
    const name = data.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    assert.equal(data.readUInt32LE(local), 0x04034b50, 'invalid APK local entry')
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    assert.ok(start + size <= central, 'APK entry overlaps directory')
    entries.push({ name, method, local, start, end: start + size })
    cursor += 46 + nameLength + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32)
  }
  return { entries, central }
}

/** APK incremental packaging can leave a whole obsolete native library as ZIP padding. */
export function verifyApkLayout(data) {
  const { entries, central } = zipEntries(data)
  const spans = entries.map(entry => [entry.local, entry.end]).sort((a,b)=>a[0]-b[0])
  let previous = 0, unindexedBytes = 0, largestGap = 0
  for (const [start,end] of [...spans,[central,central]]) {
    assert.ok(start >= previous, 'overlapping APK entries')
    const gap = start - previous
    largestGap = Math.max(largestGap,gap); unindexedBytes += gap; previous = end
  }
  // Allow alignment, data descriptors and normal signing blocks, reject megabytes of stale padding.
  assert.ok(largestGap <= 1024 * 1024, `APK contains ${largestGap} bytes of unused padding; clean Android packaging outputs and rebuild`)
  return { entries: entries.length, unindexedBytes, largestGap }
}

function elfSectionNames(elf, label) {
  assert.ok(elf.length >= 64 && elf.readUInt32BE(0) === 0x7f454c46, `${label} is not an ELF file`)
  assert.ok(elf[4] === 2 && elf[5] === 1, `${label} must be a little-endian ELF64 library`)
  const shoff = Number(elf.readBigUInt64LE(0x28)), shentsize = elf.readUInt16LE(0x3a), shnum = elf.readUInt16LE(0x3c)
  const shstrndx = elf.readUInt16LE(0x3e)
  assert.ok(shentsize >= 64 && shstrndx < shnum && shoff + shnum * shentsize <= elf.length, `${label} has a truncated section table`)
  const header = index => shoff + index * shentsize
  const strings = Number(elf.readBigUInt64LE(header(shstrndx) + 24))
  const names = []
  for (let i = 0; i < shnum; i++) {
    const start = strings + elf.readUInt32LE(header(i))
    names.push(elf.toString('latin1', start, elf.indexOf(0, start)))
  }
  return names
}

/**
 * `tauri android build --debug` uses Cargo's dev profile, which embeds full DWARF unless
 * CARGO_PROFILE_DEV_DEBUG=0; Gradle keeps it (keepDebugSymbols) and the APK triples in size.
 */
export function verifyNativeLibraries(data) {
  const libraries = []
  for (const entry of zipEntries(data).entries.filter(entry => /^lib\/[^/]+\/[^/]+\.so$/.test(entry.name))) {
    assert.ok(entry.method === 0 || entry.method === 8, `${entry.name} uses unsupported ZIP compression ${entry.method}`)
    const raw = data.subarray(entry.start, entry.end)
    const elf = entry.method === 8 ? inflateRawSync(raw) : raw
    const debug = elfSectionNames(elf, entry.name).filter(name => name.startsWith('.debug_'))
    assert.deepEqual(debug, [], `${entry.name} contains debug sections (${debug.join(', ')}); rebuild with CARGO_PROFILE_DEV_DEBUG=0 (npm run android:build)`)
    libraries.push({ name: entry.name, bytes: elf.length })
  }
  assert.ok(libraries.length > 0, 'APK contains no native libraries')
  return libraries
}

/** 入库图标 (src-tauri/icons/android) 下的全部文件, 键是 APK 里的路径 res/<目录>/<文件> */
export function androidIconFiles(iconsDir = 'src-tauri/icons/android') {
  const files = new Map()
  for (const dir of readdirSync(iconsDir)) {
    for (const file of readdirSync(join(iconsDir, dir))) files.set(`res/${dir}/${file}`, join(iconsDir, dir, file))
  }
  assert.ok(files.size > 0, `${iconsDir} has no icons`)
  return files
}

/**
 * gen/android 不入库, `tauri android init` 生成的工程带的是 Tauri 默认图标 (app-v2.11.0 就这样发了出去)。
 * 启动器图标必须与入库图标逐字节一致: PNG 原样打包 (debug 构建不压 PNG), 自适应图标 XML 被编译成二进制, 只查存在。
 */
export function verifyApkIcons(data, iconsDir = 'src-tauri/icons/android') {
  const entries = new Map(zipEntries(data).entries.map(entry => [entry.name, entry]))
  const checked = []
  for (const [name, source] of androidIconFiles(iconsDir)) {
    const entry = entries.get(name)
    assert.ok(entry, `APK is missing launcher icon ${name}; build with npm run android:build (it copies src-tauri/icons/android)`)
    if (!name.endsWith('.png')) { checked.push(name); continue }
    assert.ok(entry.method === 0 || entry.method === 8, `${name} uses unsupported ZIP compression ${entry.method}`)
    const raw = data.subarray(entry.start, entry.end)
    const bytes = entry.method === 8 ? inflateRawSync(raw) : raw
    assert.ok(bytes.equals(readFileSync(source)), `APK launcher icon ${name} differs from ${source} (default Tauri icon?)`)
    checked.push(name)
  }
  return checked
}
