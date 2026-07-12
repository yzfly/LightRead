<script setup lang="ts">
import { t } from '../i18n'

export interface TocItem {
  label: string
  href?: string
  subitems?: TocItem[] | null
}

defineProps<{
  items: TocItem[]
  currentHref?: string
  depth?: number
}>()

defineEmits<{
  navigate: [href: string]
}>()
</script>

<template>
  <ul class="toc-list" :style="{ paddingLeft: depth ? '14px' : '0' }">
    <li v-for="(item, i) in items" :key="i">
      <button
        class="toc-item"
        :class="{ active: item.href && item.href === currentHref, disabled: !item.href }"
        @click="item.href && $emit('navigate', item.href)"
      >
        {{ item.label?.trim() || t('reader.untitled') }}
      </button>
      <TocList
        v-if="item.subitems?.length"
        :items="item.subitems"
        :current-href="currentHref"
        :depth="(depth ?? 0) + 1"
        @navigate="$emit('navigate', $event)"
      />
    </li>
  </ul>
</template>

<style scoped>
.toc-list {
  list-style: none;
}
.toc-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
}
.toc-item:hover {
  background: var(--bg);
  color: var(--text);
}
.toc-item.active {
  background: var(--brand-light);
  color: var(--brand);
}
.toc-item.disabled {
  cursor: default;
  color: var(--text-3);
}
</style>
