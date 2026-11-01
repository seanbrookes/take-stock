<script setup>
import { computed } from 'vue'

/**
 * Minimal inline sparkline — no charting dependency.
 * Uses currentColor so it inherits pos/neg trend coloring from its parent.
 */
const props = defineProps({
  values: { type: Array, default: () => [] },
  width: { type: Number, default: 96 },
  height: { type: Number, default: 24 },
  /**
   * Nominal number of points for the full time span. When a series has fewer
   * points than this, it is drawn only in the right-most fraction of the width
   * (its own history, ending now) instead of being stretched across the whole
   * canvas — so a young company reads as a short line hugging the right edge
   * rather than an identical-looking full-width trend.
   */
  reference: { type: Number, default: 0 },
})

const path = computed(() => {
  const vals = props.values.filter(Number.isFinite)
  if (vals.length < 2) return ''

  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const pad = 2
  const w = props.width - pad * 2
  const h = props.height - pad * 2

  // Fraction of the width this series is entitled to on a time axis. Older
  // series fill the whole span; a short history occupies only its share,
  // anchored to "now" (the right edge).
  const frac = props.reference > 0 ? Math.min(1, vals.length / props.reference) : 1
  const left = pad + w * (1 - frac)

  return vals
    .map((v, i) => {
      const x = left + ((i / (vals.length - 1)) * w * frac)
      const y = pad + h - ((v - min) / span) * h
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
})
</script>

<template>
  <svg
    v-if="path"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    fill="none"
    aria-hidden="true"
  >
    <path :d="path" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
  </svg>
</template>
