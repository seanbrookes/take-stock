<script setup>
import { computed, ref, onMounted, onBeforeUnmount, useId } from 'vue'

/**
 * Inline SVG price chart — no charting dependency.
 *
 * Draws a close-price line with a filled area, min/max annotations, and a
 * crosshair that reads out the date and price under the pointer.
 */
const props = defineProps({
  candles: { type: Array, default: () => [] },
  height: { type: Number, default: 260 },
  /**
   * Currency CODE ("CAD"), not a formatter.
   *
   * Named `currencyCode` rather than `currency` on purpose: several callers
   * import a `currency()` formatter from analysis/format.js, and in a template
   * that import shadows a same-named prop — so `:currency="currency"` silently
   * passed the *function*, which rendered its own source code into the tooltip.
   */
  currencyCode: { type: String, default: '' },
})

// SVG element ids are document-global, so a shared "fade" gradient would break
// the fill if two charts rendered at once. A module-level counter does not help
// here — every line in <script setup> runs per instance — so use Vue's own
// per-instance id (3.5+).
const gradientId = `price-fade-${useId()}`

const PAD = { top: 12, right: 56, bottom: 22, left: 8 }

const svgEl = ref(null)
const wrapEl = ref(null)
const hover = ref(null) // index into model.points

/**
 * The viewBox tracks the element's real pixel width.
 *
 * A fixed viewBox width plus `width: 100%` means the browser scales the drawing
 * with preserveAspectRatio="xMidYMid meet" — uniform scaling that *centres* the
 * content and letterboxes the sides on any container wider than the viewBox.
 * Matching the viewBox to the measured width instead gives a 1:1 mapping, so
 * the chart fills its container and strokes stay crisp.
 */
const width = ref(800)
let observer = null

onMounted(() => {
  if (!wrapEl.value) return
  observer = new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width)
    if (w > 0) width.value = w
  })
  observer.observe(wrapEl.value)
})
onBeforeUnmount(() => observer?.disconnect())

const W = computed(() => width.value)

const model = computed(() => {
  const pts = props.candles.filter((c) => Number.isFinite(c.close))
  if (pts.length < 2) return null

  const closes = pts.map((c) => c.close)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1

  const innerW = W.value - PAD.left - PAD.right
  const innerH = props.height - PAD.top - PAD.bottom

  const x = (i) => PAD.left + (i / (pts.length - 1)) * innerW
  const y = (v) => PAD.top + innerH - ((v - min) / span) * innerH

  // Coordinates are kept per point so the crosshair can snap to real data
  // rather than interpolating a position the price never had.
  const points = pts.map((c, i) => ({
    x: x(i),
    y: y(c.close),
    close: c.close,
    end: c.end,
    open: c.open,
    high: c.high,
    low: c.low,
    volume: c.volume,
  }))

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const baseline = PAD.top + innerH
  const area = `${line} L${points.at(-1).x.toFixed(1)},${baseline} L${PAD.left},${baseline} Z`

  const first = closes[0]
  const last = closes.at(-1)

  return {
    points,
    line,
    area,
    min,
    max,
    last,
    up: last >= first,
    yMax: y(max),
    yMin: y(min),
    yLast: y(last),
    baseline,
    innerW,
    startLabel: pts[0].end?.slice(0, 10) ?? '',
    endLabel: pts.at(-1).end?.slice(0, 10) ?? '',
  }
})

/**
 * Map a pointer position to the nearest data point.
 *
 * The SVG scales to its container, so client pixels have to be converted into
 * viewBox units before they mean anything.
 */
function onMove(event) {
  const m = model.value
  const svg = svgEl.value
  if (!m || !svg) return

  // Ask the SVG to convert screen pixels into its own coordinate space rather
  // than deriving it from the bounding box. getScreenCTM accounts for scaling,
  // letterboxing and any page zoom or transform; hand-rolled arithmetic
  // silently assumes the viewBox fills the element, which it need not.
  let vx
  const ctm = svg.getScreenCTM?.()
  if (ctm) {
    vx = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse()).x
  } else {
    const rect = svg.getBoundingClientRect()
    if (!rect.width) return
    vx = ((event.clientX - rect.left) / rect.width) * W.value
  }

  const ratio = (vx - PAD.left) / m.innerW
  const i = Math.round(ratio * (m.points.length - 1))
  hover.value = Math.min(Math.max(i, 0), m.points.length - 1)
}

const clear = () => (hover.value = null)

const active = computed(() => (hover.value == null ? null : model.value?.points[hover.value] ?? null))

/** Change from the first visible point — what the crosshair position means. */
const activeChange = computed(() => {
  const m = model.value
  if (!m || !active.value) return null
  const first = m.points[0].close
  return first ? (active.value.close - first) / first : null
})

const money = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—')
const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '')

/*
 * Intraday candles all fall on the same date, so a date-only label would read
 * "2026-08-21" for every point on a 1-day chart. Detected from the data rather
 * than passed in: if two candles share a date, the series is intraday, and the
 * chart already receives everything it needs to know that.
 */
const intraday = computed(() => {
  const pts = props.candles
  if (pts.length < 2) return false
  const seen = new Set()
  for (const c of pts) {
    const d = String(c.end ?? '').slice(0, 10)
    if (seen.has(d)) return true
    seen.add(d)
  }
  return false
})

const day = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (!intraday.value) {
    return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
  }
  // Time leads, because on an intraday chart that is the part that varies;
  // the date still shows so a multi-session 5-day chart stays readable.
  return `${d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })} · ${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`
}

/** Keep the tooltip inside the chart instead of letting it run off an edge. */
const tooltipStyle = computed(() => {
  const m = model.value
  if (!m || !active.value) return {}
  const pctX = (active.value.x / W.value) * 100
  return {
    left: `${Math.min(Math.max(pctX, 8), 88)}%`,
    transform: pctX > 60 ? 'translateX(-100%)' : 'translateX(0)',
  }
})
</script>

<template>
  <div ref="wrapEl" class="chart" :class="model?.up ? 'up' : 'down'">
    <svg
      v-if="model"
      ref="svgEl"
      :viewBox="`0 0 ${W} ${height}`"
      :style="{ height: `${height}px` }"
      role="img"
      :aria-label="`Price chart, ${money(model.min)} to ${money(model.max)}`"
      @pointermove="onMove"
      @pointerdown="onMove"
      @pointerleave="clear"
    >
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="currentColor" stop-opacity="0.18" />
          <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
        </linearGradient>
      </defs>

      <line :x1="PAD.left" :x2="W - PAD.right" :y1="model.baseline" :y2="model.baseline" class="axis" />
      <path :d="model.area" :fill="`url(#${gradientId})`" />
      <path
        :d="model.line"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
        stroke-linecap="round"
      />

      <g class="tick">
        <text :x="W - PAD.right + 6" :y="model.yMax + 4">{{ money(model.max) }}</text>
        <text :x="W - PAD.right + 6" :y="model.yMin + 4">{{ money(model.min) }}</text>
      </g>

      <circle v-if="!active" :cx="W - PAD.right" :cy="model.yLast" r="3" fill="currentColor" />

      <!-- crosshair -->
      <g v-if="active" class="crosshair">
        <line :x1="active.x" :x2="active.x" :y1="PAD.top" :y2="model.baseline" />
        <circle :cx="active.x" :cy="active.y" r="4" />
      </g>

      <g class="date">
        <text :x="PAD.left" :y="height - 6">{{ model.startLabel }}</text>
        <text :x="W - PAD.right" :y="height - 6" text-anchor="end">{{ model.endLabel }}</text>
      </g>

      <!-- Full-height capture area so the pointer is tracked even above or
           below the line itself. -->
      <rect
        :x="PAD.left"
        :y="PAD.top"
        :width="model.innerW"
        :height="model.baseline - PAD.top"
        fill="transparent"
      />
    </svg>

    <div v-if="model && active" class="tooltip" :style="tooltipStyle">
      <div class="t-date">{{ day(active.end) }}</div>
      <div class="t-price num">
        {{ money(active.close) }}
        <span v-if="currencyCode" class="t-cur muted">{{ currencyCode }}</span>
        <span class="t-chg" :class="activeChange >= 0 ? 'pos' : 'neg'">{{ pct(activeChange) }}</span>
      </div>
      <div v-if="active.high" class="t-ohlc muted">
        H {{ money(active.high) }} · L {{ money(active.low) }}
      </div>
    </div>

    <p v-if="!model" class="muted">Not enough price history to chart.</p>
  </div>
</template>

<style scoped>
.chart {
  color: var(--pos);
  position: relative;
}
.chart.down {
  color: var(--neg);
}

svg {
  width: 100%;
  display: block;
  touch-action: none; /* let a drag scrub the chart rather than scroll the page */
}

.axis {
  stroke: var(--border);
  stroke-width: 1;
}

text {
  font-family: var(--mono);
  font-size: 11px;
  fill: var(--text);
}

.date text {
  opacity: 0.7;
}

.crosshair line {
  stroke: var(--text-h);
  stroke-width: 1;
  stroke-dasharray: 3 3;
  opacity: 0.45;
}
.crosshair circle {
  fill: var(--bg);
  stroke: currentColor;
  stroke-width: 2;
}

.tooltip {
  position: absolute;
  top: 4px;
  /* A guard, not a layout tool: content should be short, but a tooltip must
     never grow wide enough to leave the chart. */
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  box-shadow: var(--shadow);
  pointer-events: none; /* never let the readout block its own crosshair */
  white-space: nowrap;
  font-size: 12px;
  line-height: 145%;
}

.t-date {
  color: var(--text);
  font-size: 11px;
}
.t-price {
  font-size: 14px;
  text-align: left;
}
.t-cur {
  font-size: 10px;
}
.t-chg {
  margin-left: 6px;
  font-size: 11px;
}
.t-ohlc {
  font-size: 10px;
  font-family: var(--mono);
}
</style>
