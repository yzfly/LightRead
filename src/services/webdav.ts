/**
 * WebDAV 云备份: 把整库备份 zip 推到任意 WebDAV 服务 (坚果云 / Nextcloud / Alist …),
 * 换设备从云端一键恢复. 桌面端原生请求无跨域限制.
 */
import { fetchRemote, type RequestAuth } from './net'
import { exportBackup, importBackup } from './backup'
import { useSettings } from '../stores/settings'

const FOLDER = 'LightRead'
const FILE = 'lightread-backup.zip'

function davConfig(): { base: string; auth: RequestAuth } {
  const settings = useSettings()
  const base = settings.webdavUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('请先填写 WebDAV 服务器地址')
  return {
    base,
    auth: { username: settings.webdavUser, password: settings.webdavPass },
  }
}

const backupUrl = (base: string) => `${base}/${FOLDER}/${FILE}`

/** 测试连通性 (PROPFIND 根目录) */
export async function testWebdav(): Promise<string> {
  const { base, auth } = davConfig()
  const res = await fetchRemote(base + '/', auth, {
    method: 'PROPFIND',
    headers: { depth: '0' },
    raw: true,
  })
  if (res.status === 401) throw new Error('账号或密码错误 (401)')
  if (res.status >= 400) throw new Error(`服务器返回 ${res.status}`)
  return '连接正常'
}

/** 备份到云端 */
export async function backupToWebdav(onProgress?: (msg: string) => void): Promise<void> {
  const { base, auth } = davConfig()
  const blob = await exportBackup(onProgress)
  onProgress?.('创建云端目录…')
  await fetchRemote(`${base}/${FOLDER}`, auth, { method: 'MKCOL', raw: true })
  onProgress?.(`上传备份 (${(blob.size / 1024 / 1024).toFixed(1)} MB)…`)
  const res = await fetchRemote(backupUrl(base), auth, {
    method: 'PUT',
    body: blob,
    headers: { 'content-type': 'application/zip' },
    raw: true,
  })
  if (res.status >= 400) throw new Error(`上传失败 (${res.status})`)
}

/** 云端备份信息 (不存在返回 null) */
export async function webdavBackupInfo(): Promise<{ size: number; modified: string } | null> {
  const { base, auth } = davConfig()
  const res = await fetchRemote(backupUrl(base), auth, { method: 'HEAD', raw: true })
  if (res.status === 404) return null
  if (res.status >= 400) throw new Error(`查询失败 (${res.status})`)
  return {
    size: parseInt(res.headers.get('content-length') ?? '0', 10),
    modified: res.headers.get('last-modified') ?? '',
  }
}

/** 从云端恢复 (增量合并, 已有书籍跳过) */
export async function restoreFromWebdav(
  onProgress?: (msg: string) => void,
): Promise<{ books: number; annotations: number; sources: number }> {
  const { base, auth } = davConfig()
  onProgress?.('下载云端备份…')
  const res = await fetchRemote(backupUrl(base), auth, { raw: true })
  if (res.status === 404) throw new Error('云端还没有备份')
  if (res.status >= 400) throw new Error(`下载失败 (${res.status})`)
  const blob = await res.blob()
  return importBackup(new File([blob], FILE), onProgress)
}
