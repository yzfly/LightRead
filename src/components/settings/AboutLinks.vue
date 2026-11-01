<script setup lang="ts">
/**
 * 关于页: 各系统安装包 + 微信读者群。桌面与 App 共用 (openDownload / toast 在 App 构建里解析到各自实现)。
 * 数据与规则见 services/aboutLinks.ts。
 */
import { computed, onMounted, ref } from 'vue'
import { t } from '../../i18n'
import { isTauri } from '../../storage/types'
import { MIRROR_RELEASES_URL, RELEASES_URL, copyLink, openDownload } from '../../services/updater'
import { toast } from '../../services/toast'
import { AUTHOR_WECHAT, detectPlatform, type PackageKind, type PlatformDownload, type PlatformId, type WechatGroup } from '../../services/aboutLinks'
import { loadCommunity, loadPlatformDownloads } from '../../services/aboutLinksLoad'
import { SITE_URL } from '../../services/siteLinks'

const PLATFORM_LABEL: Record<PlatformId, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  android: 'Android',
}
const PKG_KEY: Record<PackageKind, string> = {
  installer: 'settings.pkgInstaller',
  appleSilicon: 'settings.pkgAppleSilicon',
  intel: 'settings.pkgIntel',
  appimage: 'settings.pkgAppImage',
  deb: 'settings.pkgDeb',
  rpm: 'settings.pkgRpm',
  apk: 'settings.pkgApk',
}

const thisPlatform = detectPlatform(navigator.userAgent)
/** 手机上无法用本机扫本机的码, 提示截图后从相册识别 */
const onPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

const downloads = ref<PlatformDownload[]>([])
const downloadsState = ref<'loading' | 'ready' | 'failed'>('loading')
const group = ref<WechatGroup | null>(null)
const wechatId = ref(AUTHOR_WECHAT)
const groupState = ref<'loading' | 'ready'>('loading')
const qrBroken = ref(false)

/** 本机排第一, 其余按固定顺序 */
const rows = computed(() => [
  ...downloads.value.filter(d => d.platform === thisPlatform),
  ...downloads.value.filter(d => d.platform !== thisPlatform),
])

const expiresText = computed(() => {
  if (!group.value) return ''
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(group.value.expiresAt))
  const pick = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return t('settings.communityExpires', { month: pick('month'), day: pick('day') })
})

const fmtSize = (bytes: number) => (bytes > 0 ? ` · ${Math.max(1, Math.round(bytes / 1048576))} MB` : '')

async function copyWechatId() {
  if (await copyLink(wechatId.value)) toast(t('settings.communityIdCopied'), 'success')
  else toast(t('settings.communityCopyFailed', { id: wechatId.value }), 'error')
}

async function open(url: string) {
  try {
    await openDownload(url)
  } catch {
    toast(t('update.cannotOpenLink'), 'error')
  }
}

onMounted(async () => {
  void loadCommunity()
    .then(info => {
      group.value = info.group
      wechatId.value = info.wechatId
    })
    .catch(() => { group.value = null })
    .finally(() => { groupState.value = 'ready' })
  try {
    downloads.value = (await loadPlatformDownloads()).items
    downloadsState.value = 'ready'
  } catch {
    downloadsState.value = 'failed'
  }
})
</script>

<template>
  <div class="about-links-block">
    <section class="block" aria-labelledby="about-downloads-title">
      <h3 id="about-downloads-title" class="block-title">{{ t('settings.downloadsTitle') }}</h3>
      <div v-if="downloadsState === 'loading'" class="rows" aria-busy="true">
        <div v-for="i in 4" :key="i" class="row"><span class="skeleton sk-name" /><span class="skeleton sk-btn" /></div>
      </div>
      <p v-else-if="downloadsState === 'failed'" class="state">{{ t('settings.downloadsFailed') }}</p>
      <div v-else class="rows">
        <div v-for="d in rows" :key="d.platform" class="row" :data-platform="d.platform">
          <div class="row-name">
            <span class="platform">{{ PLATFORM_LABEL[d.platform] }}</span>
            <span v-if="d.platform === thisPlatform" class="chip chip-brand">{{ t('settings.downloadsThisDevice') }}</span>
            <span v-if="d.platform === 'android'" class="chip">{{ t('settings.downloadsExperimental') }}</span>
            <span class="version">v{{ d.version }}</span>
          </div>
          <div class="row-actions">
            <button
              v-for="p in d.packages"
              :key="p.name"
              type="button"
              class="btn btn-sm"
              :title="p.name"
              @click="open(p.url)"
            >{{ t(PKG_KEY[p.kind]) }}<span class="size">{{ fmtSize(p.size) }}</span></button>
          </div>
        </div>
      </div>
      <p class="more-links">
        <a href="javascript:void 0" @click="open(SITE_URL)">{{ t('settings.website') }}</a>
        <a href="javascript:void 0" @click="open(RELEASES_URL)">{{ t('settings.downloadsAll') }}</a>
        <a href="javascript:void 0" @click="open(MIRROR_RELEASES_URL)">{{ t('settings.downloadsMirror') }}</a>
      </p>
    </section>

    <section class="block" aria-labelledby="about-community-title">
      <h3 id="about-community-title" class="block-title">{{ t('settings.communityTitle') }}</h3>
      <div class="community">
        <!-- 过期 / 取不到时不留空框, 只剩文字与「复制微信号」 -->
        <div v-if="groupState === 'loading' || (group && !qrBroken)" class="qr">
          <span v-if="groupState === 'loading'" class="skeleton sk-qr" aria-hidden="true" />
          <img
            v-else-if="group"
            :src="group.image"
            :alt="t('settings.communityQrAlt', { name: group.name })"
            width="160"
            height="160"
            @error="qrBroken = true"
          />
        </div>
        <div class="community-copy">
          <template v-if="group && !qrBroken">
            <div class="group-name">{{ group.name }}</div>
            <p>{{ t('settings.communityDesc') }}</p>
            <p v-if="onPhone && isTauri()" class="hint">{{ t('settings.communityPhoneHint') }}</p>
            <p class="hint">{{ expiresText }}</p>
          </template>
          <p v-else-if="groupState === 'ready'">{{ t('settings.communityFallback', { id: wechatId }) }}</p>
          <!-- 加作者微信拉群: 二维码有效时作为另一种方式, 过期时是唯一入口 -->
          <p v-if="groupState === 'ready'" class="wechat-line">
            <span v-if="group && !qrBroken">{{ t('settings.communityWechat', { id: wechatId }) }}</span>
            <button type="button" class="btn btn-sm copy-id" @click="copyWechatId">{{ t('settings.communityCopyId') }}</button>
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.about-links-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  margin: var(--space-2) 0 var(--space-6);
}
.block-title {
  margin: 0 0 var(--space-2);
  font-size: var(--fs-sm, 13px);
  font-weight: 600;
  color: var(--text-3);
}
.rows {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  min-height: 52px;
  padding: var(--space-2) var(--space-4);
}
.row + .row {
  border-top: 1px solid var(--border);
}
.row-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.platform {
  font-weight: 500;
}
.version {
  font-size: var(--fs-sm, 13px);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.chip {
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--fs-xs, 12px);
  line-height: 20px;
}
.chip-brand {
  background: var(--brand-soft);
  color: var(--brand);
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.size {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.state {
  margin: 0;
  padding: var(--space-4);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-3);
  font-size: var(--fs-sm, 13px);
}
.more-links {
  display: flex;
  gap: var(--space-4);
  margin: var(--space-2) 0 0;
  font-size: var(--fs-sm, 13px);
}
.more-links a {
  color: var(--text-2);
}
.more-links a:hover {
  color: var(--brand);
}
.community {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.qr {
  flex-shrink: 0;
  width: 160px;
  height: 160px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  background: #fff; /* 二维码需要白底才能被识别, 深色模式也保持 */
  overflow: hidden;
}
.qr img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.community-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.community-copy p {
  margin: 0;
  color: var(--text-2);
  font-size: var(--fs-sm, 13px);
}
.community-copy .wechat-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin-top: var(--space-2);
}
.copy-id {
  flex-shrink: 0;
}
.group-name {
  font-weight: 600;
}
.community-copy .hint {
  color: var(--text-3);
  font-size: var(--fs-xs, 12px);
}
.skeleton {
  display: block;
  border-radius: var(--radius-sm);
}
.sk-name {
  width: 120px;
  height: 16px;
  margin-right: auto;
}
.sk-btn {
  width: 96px;
  height: 28px;
}
.sk-qr {
  width: 100%;
  height: 100%;
}
@media (max-width: 720px) {
  .row {
    padding: var(--space-3) var(--space-4);
  }
  .row-name,
  .row-actions {
    flex: 1 1 100%;
  }
  /* 手机: 按钮高度保持触控尺寸, 收窄左右留白, 同一系统的包尽量排在一行 */
  .row-actions .btn {
    padding: 0 var(--space-3);
    font-size: var(--fs-sm, 13px);
  }
  .size {
    display: none;
  }
  .community {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
