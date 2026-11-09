<script setup lang="ts">
/**
 * 带档位刻度的滑动条: 默认几档有名字 (如 慢 / 适中 / 快), 点刻度直接到那一档, 也可以拖到两档之间微调。
 * 只显示档位名, 不让读者换算数值 (秒数、百分比)。
 */
import { computed } from 'vue'

const props = defineProps<{
  modelValue: number
  min: number
  max: number
  step?: number
  /** 有名字的档位, value 在 [min, max] 内, 按从左到右排列 */
  /** minor: 只画刻度不显示文字 (档位挤在一起时), 名字仍给读屏和悬停提示 */
  stops: Array<{ value: number; label: string; minor?: boolean }>
  /** 无障碍名称 (读屏读出「速度：适中」) */
  label: string
  /** 滑动条右侧显示的当前值 (如第几档); 不传则不显示 */
  valueText?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const pct = (v: number) => ((v - props.min) / (props.max - props.min)) * 100
/** 当前值最接近的档位 (在两档之间时显示近的那一档) */
const nearest = computed(() => {
  let best = 0
  props.stops.forEach((s, i) => {
    if (Math.abs(s.value - props.modelValue) < Math.abs(props.stops[best].value - props.modelValue)) best = i
  })
  return best
})
const exact = computed(() => Math.abs(props.stops[nearest.value].value - props.modelValue) < (props.step ?? 0.01) / 2)

function onInput(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(v)) emit('update:modelValue', v)
}
</script>

<template>
  <div class="level-slider" :style="{ '--fill': pct(modelValue) + '%' }">
    <input
      class="ls-range"
      type="range"
      :min="min"
      :max="max"
      :step="step ?? 0.01"
      :value="modelValue"
      :aria-label="label"
      :aria-valuetext="valueText ? `${valueText} · ${stops[nearest].label}` : stops[nearest].label"
      @input="onInput"
    />
    <span v-if="valueText" class="ls-value" aria-hidden="true">{{ valueText }}</span>
    <div class="ls-stops">
      <button
        v-for="(s, i) in stops"
        :key="s.value"
        type="button"
        class="ls-stop"
        :class="{ active: nearest === i, exact: nearest === i && exact, minor: s.minor }"
        :title="s.minor ? s.label : undefined"
        :style="{ left: pct(s.value) + '%' }"
        :aria-pressed="nearest === i && exact"
        @click="emit('update:modelValue', s.value)"
      >
        <span class="ls-tick" aria-hidden="true" />
        <span class="ls-label" :class="{ 'sr-only': s.minor }">{{ s.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.level-slider {
  position: relative;
  flex: 1;
  min-width: 0;
  padding: 0 14px;
}
.level-slider:has(.ls-value) {
  padding-right: 44px;
}
.ls-value {
  position: absolute;
  top: 0;
  right: 0;
  width: 36px;
  line-height: 22px;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.ls-range {
  display: block;
  width: 100%;
  height: 22px;
  margin: 0;
  accent-color: var(--brand);
  cursor: pointer;
}
.ls-stops {
  position: relative;
  height: 30px;
  margin-top: 2px;
}
.ls-stop {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 34px;
  padding: 0 2px;
  border: none;
  background: none;
  color: var(--text-3);
  font: inherit;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
}
.ls-stop.minor {
  min-width: 0;
  width: var(--space-4);
  height: 100%;
}
.ls-tick {
  width: 2px;
  height: 5px;
  border-radius: 1px;
  background: var(--border);
}
.ls-stop:hover {
  color: var(--text-2);
}
.ls-stop.active {
  color: var(--brand);
  font-weight: 600;
}
.ls-stop.active .ls-tick {
  background: var(--brand);
}
.ls-stop:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: var(--radius-sm);
}
@media (hover: none) {
  .ls-range {
    height: 32px;
  }
  .ls-stops {
    height: 36px;
  }
  .ls-stop {
    min-width: 44px;
    min-height: 36px;
    font-size: 13px;
  }
}
</style>
