<script setup>
import { computed } from 'vue'
import { currency } from '../analysis/format.js'

/**
 * Market-cap magnitude bar for a table cell.
 *
 * TWO DELIBERATE CHOICES:
 *
 * 1. LOG SCALE. The universe spans ~$150K to ~$416B — six and a half orders of
 *    magnitude. On a linear scale Royal Bank fills the cell and every company
 *    under $10B is an invisible sub-pixel sliver, which is worse than no chart.
 *    A log scale keeps the whole range readable. The trade is that half height
 *    is NOT half the value, so the caption has to say "log scale" — an unlabelled
 *    log axis is a way of misleading people.
 *
 * 2. ONE COLOUR, NOT A HUE RAMP. Tinting bigger companies a different hue would
 *    double-encode: hue would carry exactly the information height already
 *    carries, spending the one free visual channel on nothing. Height answers
 *    "how big"; colour is left free to mean something else later.
 *
 * The domain is fixed rather than derived from the rows on screen, so a bar
 * means the same thing whichever filter is applied — otherwise switching from
 * "all" to "$10B+" would silently rescale every bar.
 */
const props = defineProps({
  value: { type: Number, default: null },
  /** Fixed domain: $100K to $1T. */
  min: { type: Number, default: 1e5 },
  max: { type: Number, default: 1e12 },
  width: { type: Number, default: 24 },
  height: { type: Number, default: 26 },
})

const RADIUS = 4

const fraction = computed(() => {
  const v = props.value
  if (!Number.isFinite(v) || v <= 0) return null
  const lo = Math.log10(props.min)
  const hi = Math.log10(props.max)
  const t = (Math.log10(v) - lo) / (hi - lo)
  return Math.min(Math.max(t, 0), 1)
})

/** Always leave a visible stub, so "tiny" still reads as a mark rather than nothing. */
const barHeight = computed(() =>
  fraction.value == null ? 0 : Math.max(fraction.value * props.height, 2),
)

const label = computed(() =>
  props.value ? `${currency(props.value)} — bar is log-scaled` : 'No market cap',
)
</script>

<template>
  <svg
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    class="magnitude"
    role="img"
    :aria-label="label"
  >
    <title>{{ label }}</title>

    <!-- Track: gives the bar a scale to be read against. -->
    <rect x="0" :y="0" :width="width" :height="height" :rx="RADIUS" class="track" />

    <!-- Rounded data-end, square at the baseline: the rect is drawn taller than
         the visible bar and clipped by the cell edge, so only the top rounds. -->
    <rect
      v-if="barHeight > 0"
      x="0"
      :y="height - barHeight"
      :width="width"
      :height="barHeight + RADIUS"
      :rx="RADIUS"
      class="bar"
    />
  </svg>
</template>

<style scoped>
.magnitude {
  /* Built for a table cell: sits inline beside the value it annotates. */
  display: inline-block;
  vertical-align: middle;
  margin-left: 8px;
  overflow: hidden; /* squares off the baseline end */
}

.track {
  fill: var(--code-bg);
}

.bar {
  fill: var(--accent);
  opacity: 0.75;
}
</style>
