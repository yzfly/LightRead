#!/usr/bin/env node
// `tauri android init` 生成的工程 (src-tauri/gen/android, 不入库) 之上的补丁, CI 与本机构建都在 init 之后运行:
//   node scripts/patch-android-project.mjs [src-tauri/gen/android]
//
// 应用内更新 (src/services/updater.ts + src-tauri/android/MainActivity.kt) 需要:
//  1. 清单声明 REQUEST_INSTALL_PACKAGES, 否则无法拉起系统安装器、也无法申请「安装未知应用」;
//  2. FileProvider `${applicationId}.fileprovider` 能共享 cacheDir 下的文件。Tauri 模板自带该
//     provider 与 cache-path "."; 缺 cache-path 时补一条只覆盖 updates/ 的路径, 缺 provider 直接报错。
// 划词「用其他应用翻译」(MainActivity.kt 的 LightReadShare.processText) 需要:
//  3. <queries> 声明 PROCESS_TEXT, 否则 Android 11+ 的软件包可见性规则下查不到已安装的翻译应用。
// 脚本是幂等的。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL_PERMISSION = '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />'

const PROCESS_TEXT_QUERY = '<queries>\n        <intent>\n            <action android:name="android.intent.action.PROCESS_TEXT" />\n            <data android:mimeType="text/plain" />\n        </intent>\n    </queries>'

export function patchManifest(xml) {
  if (!/android:authorities="\$\{applicationId\}\.fileprovider"/.test(xml) || !xml.includes('androidx.core.content.FileProvider')) {
    throw new Error('AndroidManifest.xml 缺少 ${applicationId}.fileprovider 的 FileProvider, 应用内更新无法安装')
  }
  return patchProcessTextQuery(patchInstallPermission(xml))
}

function patchProcessTextQuery(xml) {
  if (xml.includes('android.intent.action.PROCESS_TEXT')) return xml
  const app = xml.match(/^([ \t]*)<application\b/m)
  if (!app) throw new Error('AndroidManifest.xml 缺少 <application>')
  return xml.replace(app[0], `${app[1]}${PROCESS_TEXT_QUERY}\n${app[0]}`)
}

function patchInstallPermission(xml) {
  if (xml.includes('android.permission.REQUEST_INSTALL_PACKAGES')) return xml
  const anchor = xml.match(/^([ \t]*)<uses-permission android:name="android\.permission\.INTERNET"\s*\/>/m)
  if (anchor) return xml.replace(anchor[0], `${anchor[0]}\n${anchor[1]}${INSTALL_PERMISSION}`)
  const open = xml.match(/<manifest\b[^>]*>/)
  if (!open) throw new Error('AndroidManifest.xml 缺少 <manifest>')
  return xml.replace(open[0], `${open[0]}\n    ${INSTALL_PERMISSION}`)
}

export function patchFilePaths(xml) {
  // cache-path 覆盖整个缓存目录 (".") 或 updates/ 时无需改动
  if (/<cache-path\b[^>]*android:path="(\.|\.\/|updates\/?)"/.test(xml) || /<cache-path\b[^>]*\bpath="(\.|\.\/|updates\/?)"/.test(xml)) return xml
  if (!xml.includes('</paths>')) throw new Error('file_paths.xml 缺少 <paths>')
  return xml.replace('</paths>', '  <cache-path name="lightread_updates" path="updates/" />\n</paths>')
}

function main() {
  const root = process.argv[2] ?? 'src-tauri/gen/android'
  const manifestPath = join(root, 'app/src/main/AndroidManifest.xml')
  const pathsPath = join(root, 'app/src/main/res/xml/file_paths.xml')
  const manifest = readFileSync(manifestPath, 'utf8')
  const paths = readFileSync(pathsPath, 'utf8')
  const nextManifest = patchManifest(manifest)
  const nextPaths = patchFilePaths(paths)
  if (nextManifest !== manifest) writeFileSync(manifestPath, nextManifest)
  if (nextPaths !== paths) writeFileSync(pathsPath, nextPaths)
  console.log(`Android 工程已就绪: 清单${nextManifest !== manifest ? '已补上' : '无需改动'}, 缓存共享路径${nextPaths !== paths ? '已补上' : '已存在'}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
