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
// 后台听书 (MainActivity.kt 末尾的 ListenService) 需要:
//  4. 前台服务 / 媒体播放类型 / 唤醒锁 / 通知权限, 以及 <service> 声明 (foregroundServiceType="mediaPlayback");
//     缺了任何一项, 熄屏或切到后台几分钟后系统会冻结应用, 听书中断 (红米 / 小米最明显)。
// 脚本是幂等的。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROCESS_TEXT_QUERY = '<queries>\n        <intent>\n            <action android:name="android.intent.action.PROCESS_TEXT" />\n            <data android:mimeType="text/plain" />\n        </intent>\n    </queries>'

const LISTEN_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.WAKE_LOCK',
  'android.permission.POST_NOTIFICATIONS',
]

const LISTEN_SERVICE = '<service\n            android:name=".ListenService"\n            android:exported="false"\n            android:foregroundServiceType="mediaPlayback" />'

/** 接在最后一条权限声明之后 (没有就放在 <manifest> 开头), 不打乱已有顺序; 已有则不动 */
function addPermission(xml, name) {
  if (xml.includes(`"${name}"`)) return xml
  const line = `<uses-permission android:name="${name}" />`
  const last = [...xml.matchAll(/^([ \t]*)<uses-permission\b[^>]*\/>/gm)].at(-1)
  if (last) {
    const at = last.index + last[0].length
    return `${xml.slice(0, at)}\n${last[1]}${line}${xml.slice(at)}`
  }
  const open = xml.match(/<manifest\b[^>]*>/)
  if (!open) throw new Error('AndroidManifest.xml 缺少 <manifest>')
  return xml.replace(open[0], `${open[0]}\n    ${line}`)
}

function patchListenService(xml) {
  const next = LISTEN_PERMISSIONS.reduce(addPermission, xml)
  if (next.includes('android:name=".ListenService"')) return next
  const at = next.lastIndexOf('</application>')
  if (at < 0) throw new Error('AndroidManifest.xml 缺少 </application>')
  return `${next.slice(0, at)}    ${LISTEN_SERVICE}\n    ${next.slice(at)}`
}

export function patchManifest(xml) {
  if (!/android:authorities="\$\{applicationId\}\.fileprovider"/.test(xml) || !xml.includes('androidx.core.content.FileProvider')) {
    throw new Error('AndroidManifest.xml 缺少 ${applicationId}.fileprovider 的 FileProvider, 应用内更新无法安装')
  }
  return patchListenService(patchProcessTextQuery(addPermission(xml, 'android.permission.REQUEST_INSTALL_PACKAGES')))
}

function patchProcessTextQuery(xml) {
  if (xml.includes('android.intent.action.PROCESS_TEXT')) return xml
  const app = xml.match(/^([ \t]*)<application\b/m)
  if (!app) throw new Error('AndroidManifest.xml 缺少 <application>')
  return xml.replace(app[0], `${app[1]}${PROCESS_TEXT_QUERY}\n${app[0]}`)
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
