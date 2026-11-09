<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../stores/library'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'
import { readerPath } from '../services/readerRoute'
import { loadDaily, localDay, onReadingLogChange } from '../services/readingLog'
import { ACTIVE_DAY_SECONDS, addDays, streaks, weekStrip, type DailyMap } from '../services/readingStats'
import type { BookMeta } from '../storage'
import TodayCard from '../components/stats/TodayCard.vue'
import WeekStrip from '../components/stats/WeekStrip.vue'
import TrendCard from '../components/stats/TrendCard.vue'
import ReadingCalendar from '../components/stats/ReadingCalendar.vue'
import Milestones from '../components/stats/Milestones.vue'
import DayDetailSheet from '../components/stats/DayDetailSheet.vue'

const router = useRouter()
const library = useLibrary()
const settings = useSettings()

// ---- 数据: 按天聚合的阅读记录; 记录 / 同步落地 / 导入后实时刷新 ----
const daily = ref<DailyMap>({})
const loaded = ref(false)
const today = ref(localDay())

async function reload() {
  try {
    daily.value = await loadDaily()
  } catch {
    daily.value = {}
  }
  today.value = localDay()
  loaded.value = true
}

let stopLog: (() => void) | undefined
onMounted(() => {
  if (!library.loaded) void library.refresh()
  void reload()
  stopLog = onReadingLogChange(() => void reload())
})
onBeforeUnmount(() => stopLog?.())

const hasData = computed(() => Object.values(daily.value).some(e => e.seconds > 0))
const booksById = computed(() => new Map(library.books.map(b => [b.id, b])))
const firstDay = computed(() => Object.keys(daily.value).filter(d => daily.value[d].seconds > 0).sort()[0] ?? today.value)

// ---- 今日 ----
const goalMinutes = computed(() => Math.max(0, Math.round(settings.dailyGoalMinutes || 0)))
const todaySeconds = computed(() => daily.value[today.value]?.seconds ?? 0)
const yesterday = computed(() => addDays(today.value, -1))
const yesterdaySeconds = computed(() => daily.value[yesterday.value]?.seconds ?? 0)
const streak = computed(() => streaks(daily.value, today.value))
const week = computed(() => weekStrip(daily.value, today.value, goalMinutes.value * 60))
/** 继续阅读: 最近读过且仍在书架上的一本 */
const continueBook = computed<BookMeta | undefined>(() => {
  let best: BookMeta | undefined
  for (const b of library.books) {
    if (b.lastReadAt && (!best || b.lastReadAt > (best.lastReadAt ?? 0))) best = b
  }
  return best
})
const legacySeconds = computed(() => library.books.reduce((sum, b) => sum + (b.readingSeconds ?? 0), 0))

function setGoal(m: number) {
  settings.dailyGoalMinutes = m
}
function openBook(book: BookMeta) {
  void router.push(readerPath(book))
}

// ---- 当天详情 (桌面右侧面板 / 手机底部面板) ----
const detailDay = ref<string | null>(null)
const lastPicked = ref<string | null>(null)
const returnFocus = ref<HTMLElement | null>(null)
function openDay(day: string, trigger?: HTMLElement) {
  returnFocus.value = trigger ?? (document.activeElement as HTMLElement | null)
  detailDay.value = day
  lastPicked.value = day
}
function navigateDay(day: string) {
  detailDay.value = day
  lastPicked.value = day
}

// ---- 计时说明 ----
const showHow = ref(false)
</script>

<template>
  <div class="stats">
    <header class="page-head">
      <h1>{{ t('stats.title') }}</h1>
      <button
        type="button"
        class="btn btn-ghost btn-sm how-btn"
        :aria-label="t('stats.howTitle')"
        :title="t('stats.howTitle')"
        :aria-expanded="showHow"
        aria-controls="stats-how"
        @click="showHow = !showHow"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 7a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0v-4a1 1 0 0 1 1-1zm0-4a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 12 7z" /></svg>
        <span class="how-label">{{ t('stats.howTitle') }}</span>
      </button>
    </header>
    <div v-if="showHow" id="stats-how" class="how">
      <ul>
        <li>{{ t('stats.how1') }}</li>
        <li>{{ t('stats.how2') }}</li>
        <li>{{ t('stats.how3') }}</li>
        <li>{{ t('stats.how4') }}</li>
      </ul>
    </div>

    <!-- 加载中 -->
    <div v-if="!loaded" class="layout" aria-busy="true">
      <div class="skeleton sk-today" />
      <div class="side"><div class="skeleton sk-week" /></div>
      <div class="skeleton sk-trend" />
    </div>

    <!-- 空状态 -->
    <section v-else-if="!hasData" class="card empty-card">
      <div class="empty">
        <svg class="empty-art" viewBox="0 0 168 104" aria-hidden="true">
          <g v-for="(row, ri) in [[0,1,0,2,0,3,1],[1,0,3,0,2,4,0],[0,2,1,4,0,2,3]]" :key="ri">
            <rect
              v-for="(lv, ci) in row"
              :key="ci"
              :x="4 + ci * 23"
              :y="8 + ri * 23"
              width="18"
              height="18"
              rx="4"
              :class="`art-l${lv}`"
            />
          </g>
          <rect x="4" y="80" width="64" height="6" rx="3" class="art-line" />
          <rect x="4" y="92" width="40" height="6" rx="3" class="art-line soft" />
        </svg>
        <p class="empty-title">{{ t('stats.emptyTitle') }}</p>
        <p class="empty-desc">{{ t('stats.emptyDesc') }}</p>
        <div class="empty-actions">
          <button v-if="continueBook" type="button" class="btn btn-primary" @click="openBook(continueBook)">
            {{ t('stats.emptyContinue', { title: continueBook.title }) }}
          </button>
          <router-link to="/library" class="btn" :class="{ 'btn-primary': !continueBook }">{{ t('stats.emptyAction') }}</router-link>
        </div>
      </div>
    </section>

    <div v-else class="layout">
      <TodayCard
        class="a-today"
        :today="today"
        :today-seconds="todaySeconds"
        :yesterday-seconds="yesterdaySeconds"
        :goal-minutes="goalMinutes"
        :streak="streak.current"
        :today-active="todaySeconds >= ACTIVE_DAY_SECONDS"
        :yesterday-active="yesterdaySeconds >= ACTIVE_DAY_SECONDS"
        :continue-book="continueBook"
        @set-goal="setGoal"
        @open="openBook"
      />
      <div class="side">
        <WeekStrip class="a-week" :days="week" :goal-minutes="goalMinutes" :today="today" @select="openDay" />
        <Milestones
          class="a-ms"
          :daily="daily"
          :today="today"
          :books-by-id="booksById"
          :legacy-seconds="legacySeconds"
          @select-day="openDay"
          @open="openBook"
        />
      </div>
      <TrendCard
        class="a-trend"
        :daily="daily"
        :today="today"
        :goal-minutes="goalMinutes"
        :books-by-id="booksById"
        @select-day="openDay"
        @open="openBook"
      />
      <ReadingCalendar
        class="a-cal"
        :daily="daily"
        :today="today"
        :selected-day="lastPicked"
        @select="openDay"
      />
    </div>

    <DayDetailSheet
      :day="detailDay"
      :today="today"
      :first-day="firstDay"
      :entry="detailDay ? daily[detailDay] : undefined"
      :goal-minutes="goalMinutes"
      :books-by-id="booksById"
      :return-focus="returnFocus"
      @close="detailDay = null"
      @navigate="navigateDay"
      @open="openBook"
    />
  </div>
</template>

<style scoped>
.stats {
  max-width: calc(var(--page-max) + 2 * var(--page-x));
  margin: 0 auto;
  padding: var(--page-top) var(--page-x) calc(var(--page-bottom) + var(--lr-safe-bottom));
}
.page-head {
  display: flex;
  /* Windows 自绘窗口按钮在右上角, 标题行右侧让开 (--chrome-inset-right, styles/main.css) */
  padding-right: var(--chrome-inset-right);
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
h1 {
  font-size: var(--page-title);
  font-weight: 700;
  letter-spacing: -0.015em;
}
.how-btn {
  color: var(--text-2);
}
.how-btn[aria-expanded='true'] {
  background: var(--surface-2);
  color: var(--text);
}
.how {
  margin: -6px 0 16px;
  padding: 14px 18px;
  border-radius: var(--radius-lg);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.65;
  animation: how-in var(--dur) var(--ease);
}
.how ul {
  padding-left: 18px;
  max-width: 72ch;
}
@keyframes how-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}

/* ---- 布局: 手机 / 平板单列; 桌面 ≥ 960px 左主右辅, 日历通栏 ---- */
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: 'today' 'week' 'trend' 'cal' 'ms';
  gap: 16px;
}
.side {
  display: contents;
}
.a-today { grid-area: today; }
.a-week { grid-area: week; }
.a-trend { grid-area: trend; }
.a-cal { grid-area: cal; }
.a-ms { grid-area: ms; }

@media (min-width: 960px) {
  .layout {
    grid-template-columns: minmax(0, 1fr) minmax(300px, 340px);
    grid-template-areas:
      'today side'
      'trend side'
      'cal cal';
    align-items: start;
  }
  .side {
    grid-area: side;
    display: flex;
    flex-direction: column;
    gap: 16px;
    position: sticky;
    top: 16px;
  }
}

/* ---- 加载骨架 ---- */
.sk-today { grid-area: today; height: 240px; border-radius: var(--radius-lg); }
.sk-week { height: 150px; border-radius: var(--radius-lg); }
.sk-trend { grid-area: trend; height: 420px; border-radius: var(--radius-lg); }
.layout[aria-busy='true'] .side > .skeleton {
  grid-area: week;
}

/* ---- 空状态 ---- */
.empty-card .empty {
  padding: 56px 24px 60px;
}
.empty-art {
  width: 168px;
  height: 104px;
  margin-bottom: 10px;
}
.art-l0 { fill: var(--surface-3); }
.art-l1 { fill: var(--brand); opacity: 0.25; }
.art-l2 { fill: var(--brand); opacity: 0.48; }
.art-l3 { fill: var(--brand); opacity: 0.72; }
.art-l4 { fill: var(--brand); }
.art-line { fill: var(--surface-3); }
.art-line.soft { opacity: 0.6; }
.empty-desc {
  max-width: 400px;
  font-size: 13px;
  line-height: 1.65;
}

@media (max-width: 720px) {
  .page-head {
    margin-bottom: 14px;
    min-height: 44px;
  }
  h1 {
    font-size: 26px;
    letter-spacing: 0.02em;
  }
  /* 手机: 「如何计时」只留图标 */
  .how-btn {
    width: 40px;
    height: 40px;
    padding: 0;
    justify-content: center;
    border-radius: 50%;
  }
  .how-btn svg {
    width: 20px;
    height: 20px;
  }
  .how-label {
    display: none;
  }
  .layout {
    gap: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .how {
    animation: none;
  }
}
</style>
