#!/usr/bin/env node
// 重新生成 iOS 应用图标 src-tauri/icons/ios/*.png (需要 rsvg-convert, Mac 上 brew install librsvg):
//   node scripts/build-ios-icons.mjs
// iOS 图标必须是不透明的正方形 (系统自己切圆角), App Store 拒收带透明通道的大图标:
// 源图 src-tauri/icons/source/ios-icon.svg 是去掉圆角的 app-icon.svg, 整张不透明, rsvg-convert 就输出不带 alpha 的 RGB。
// build-ios.mjs 打包前用 pngHasAlpha 再核对一次。
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'src-tauri/icons/source/ios-icon.svg'
const OUT = 'src-tauri/icons/ios'

/** IHDR 颜色类型带 alpha (4 / 6) 或有 tRNS 块都算透明 */
export function pngHasAlpha(png) {
  const colorType = png[25]
  return colorType === 4 || colorType === 6 || png.includes(Buffer.from('tRNS'))
}

/** AppIcon-60x60@3x.png → 180; AppIcon-512@2x.png → 1024 */
export function iconPixels(name) {
  const match = name.match(/^AppIcon-([\d.]+)(?:x[\d.]+)?@(\d)x(?:-\d)?\.png$/)
  if (!match) throw new Error(`认不出图标尺寸: ${name}`)
  return Math.round(Number(match[1]) * Number(match[2]))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  for (const name of readdirSync(OUT).filter(file => file.endsWith('.png'))) {
    const size = iconPixels(name)
    const png = execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), SOURCE])
    if (pngHasAlpha(png)) throw new Error(`${name}: 渲染结果带透明通道, 检查 ${SOURCE} 是否整张不透明`)
    writeFileSync(join(OUT, name), png)
    console.log(`${name} ${size}×${size}`)
  }
}
