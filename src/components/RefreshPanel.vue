<script setup>
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { fetchHealth } from '../api/local.js'

/**
 * What the refresh buttons will cost, and whether they are worth pressing.
 *
 * Exists because the honest answer to "should I refresh?" is a number, not a
 * habit: prices self-limit on a 6-hour rule, so a press an hour after the last
 * one fetches nothing, while a fundamentals sweep at no cap filter is 1,600
 * filings. Neither fact is visible from the buttons alone, and guessing wrong
 * in either direction is bad — wasted API budget, or acting on stale figures.
 *
 * Every figure here is a local read. Opening the panel must never itself spend
 * budget, or the thing reporting on cost becomes a source of it.
 */
const props = defineProps({
  /** Cap filter in force, so the fundamentals estimate matches the button. */
  minCap: { type: Number, default: 0 },
  /** True while either job runs, to poll faster and re-read when it lands. */
  busy: { type: Boolean, default: false },
})

const open = ref(false)
const health = ref(null)
const error = ref(null)

async function load() {
  try {
    health.value = await fetchHealth({ minCap: props.minCap || undefined })
    error.value = null
  } catch (err) {
    error.value = err
  }
}

// Only polls while open — a collapsed panel costs nothing at all.
let timer = null
function schedule() {
  clearInterval(timer)
  if (!open.value) return
  timer = setInterval(load, props.busy ? 2000 : 30_000)
}
watch([open, () => props.busy], () => {
  if (open.value) load()
  schedule()
})
// A finished run changes every number here.
watch(
  () => props.busy,
  (now, before) => before && !now && load(),
)
watch(() => props.minCap, load)
onMounted(load)
onUnmounted(() => clearInterval(timer))

// --- formatting -----------------------------------------------------------

const ago = (iso) => {
  if (!iso) return 'never'
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000
  if (mins < 1) return 'just now'
  if (mins < 60) return `${Math.round(mins)}m ago`
  const hrs = mins / 60
  if (hrs < 48) return `${Math.round(hrs)}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const dur = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

const mb = (bytes) =>
  bytes == null ? '—' : bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)}GB` : `${Math.round(bytes / 1e6)}MB`

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0)

/**
 * Traffic light. Deliberately three states plus "unknown" — a finer scale would
 * imply a precision these thresholds do not have.
 */
const tone = (value, { good, warn }) =>
  value == null ? 'unknown' : value >= good ? 'ok' : value >= warn ? 'warn' : 'bad'

// --- the four indicators --------------------------------------------------

/**
 * Questrade's own count is authoritative where we have it: our hourly counter
 * only sees what this dev-server process spent, and misses another session or
 * a restart mid-window.
 */
const budget = computed(() => {
  const q = health.value?.questrade
  if (!q) return null
  const reported = Number.isFinite(q.remaining) ? q.remaining : null
  const spent = q.hourCount ?? 0
  const remaining = reported ?? Math.max(q.perHour - spent, 0)
  return {
    remaining,
    perHour: q.perHour,
    spent,
    share: remaining / q.perHour,
    reported: reported != null,
    observedAt: q.observedAt,
    queued: q.waiting ?? 0,
    blocked: q.blockedUntil > Date.now(),
  }
})

const priceAge = computed(() => {
  const p = health.value?.prices
  if (!p?.newest) return null
  const hours = (Date.now() - new Date(p.newest).getTime()) / 3600_000
  return { hours, stale: p.stale ?? 0, priced: p.priced ?? 0, wouldFetch: p.wouldFetch ?? 0 }
})

const cache = computed(() => {
  const c = health.value?.candles
  if (!c?.tracked) return null
  return { fresh: c.fresh ?? 0, tracked: c.tracked, share: (c.fresh ?? 0) / c.tracked }
})

const grade = computed(() => {
  const v = health.value?.valuation
  const f = health.value?.fundamentals
  const d = health.value?.debt
  if (!v) return null
  return {
    graded: v.rows ?? 0,
    multi: v.multi_factor ?? 0,
    computedAt: v.computed_at,
    rows: f?.rows ?? 0,
    wouldFetch: f?.wouldFetch ?? 0,
    debtGraded: d?.graded ?? 0,
    debtWarned: d?.warned ?? 0,
    debtExcluded: d?.excluded ?? 0,
  }
})

/**
 * The headline when collapsed. Prices lead because they are the only figure
 * that goes stale on its own and the only one that regrades everything.
 */
const summary = computed(() => {
  if (error.value) return { text: 'status unavailable', tone: 'unknown' }
  if (!health.value) return { text: 'checking…', tone: 'unknown' }
  const p = priceAge.value
  if (!p) return { text: 'no prices yet', tone: 'bad' }
  const t = p.hours < 6 ? 'ok' : p.hours < 24 ? 'warn' : 'bad'
  const b = budget.value
  return {
    text: `prices ${ago(health.value.prices.newest)} · ${b ? `${b.remaining.toLocaleString()} calls left` : 'budget unknown'}`,
    tone: t,
  }
})

const rows = computed(() => {
  const h = health.value
  if (!h) return []
  const b = budget.value
  const p = priceAge.value
  const c = cache.value
  const g = grade.value

  return [
    b && {
      key: 'budget',
      label: 'API budget',
      value: `${b.remaining.toLocaleString()} / ${b.perHour.toLocaleString()}`,
      tone: tone(b.share, { good: 0.5, warn: 0.2 }),
      note: b.blocked
        ? 'backing off — Questrade asked us to wait'
        : b.reported
          ? `Questrade's count, ${ago(b.observedAt)}${b.queued ? ` · ${b.queued} queued` : ''}`
          : `estimated from ${b.spent} requests this hour; no response seen yet`,
    },
    p && {
      key: 'prices',
      label: 'Price freshness',
      value: ago(h.prices.newest),
      // Under the 6h rule a press is a no-op, which is the healthy state.
      tone: p.hours < 6 ? 'ok' : p.hours < 24 ? 'warn' : 'bad',
      note: p.wouldFetch
        ? `${p.wouldFetch.toLocaleString()} stale — a refresh would cost about ${Math.ceil(p.wouldFetch / 40).toLocaleString()} calls`
        : 'all current — refreshing now would fetch nothing',
    },
    c && {
      key: 'cache',
      label: 'History cache',
      value: `${pct(c.fresh, c.tracked)}% fresh`,
      tone: tone(c.share, { good: 0.8, warn: 0.4 }),
      note: `${c.fresh.toLocaleString()} of ${c.tracked.toLocaleString()} symbols within the 12h window · sparklines fill from here for free`,
    },
    g && {
      key: 'grade',
      label: 'Valuation grades',
      value: `${g.graded.toLocaleString()} graded`,
      tone: g.computedAt ? 'ok' : 'unknown',
      note: `${g.multi.toLocaleString()} on 2+ factors · regraded ${ago(g.computedAt)}${
        g.wouldFetch
          ? ` · ${g.wouldFetch.toLocaleString()} companies missing filings${h.fundamentals.minCap ? ' in this cap range' : ''}`
          : ''
      }`,
    },
    g && {
      key: 'debt',
      label: 'Debt grades',
      value: `${g.debtGraded.toLocaleString()} graded`,
      tone: g.debtGraded ? 'ok' : 'unknown',
      note: `${g.debtWarned.toLocaleString()} carry an absolute warning · ${g.debtExcluded.toLocaleString()} financials not comparable`,
    },
  ].filter(Boolean)
})

/** What each button cost last time it ran. Survives a reload; lives in `meta`. */
const lastRuns = computed(() => {
  const l = health.value?.lastRun
  if (!l) return []
  const out = []
  if (l.prices) {
    out.push({
      key: 'prices',
      label: 'Refresh prices',
      when: ago(l.prices.at),
      cost: `${(l.prices.requests ?? 0).toLocaleString()} calls · ${dur(l.prices.ms)}`,
      detail: `${(l.prices.symbols ?? 0).toLocaleString()} symbols${
        l.prices.relabelled ? ` · ${l.prices.relabelled} relabelled` : ''
      }${l.prices.unresolved ? ` · ${l.prices.unresolved} unresolved` : ''}`,
      error: l.prices.error,
    })
  }
  if (l.fundamentals) {
    out.push({
      key: 'fundamentals',
      label: 'Refresh fundamentals',
      when: ago(l.fundamentals.at),
      cost: `${mb(l.fundamentals.bytes)} · ${dur(l.fundamentals.ms)}`,
      detail: `${(l.fundamentals.matched ?? 0).toLocaleString()} filings of ${(
        l.fundamentals.targets ?? 0
      ).toLocaleString()} tried · no Questrade budget`,
      error: l.fundamentals.error,
    })
  }
  return out
})

const fx = computed(() => health.value?.fx)
</script>

<template>
  <div class="panel" :class="{ open }">
    <button class="toggle" :aria-expanded="open" @click="open = !open">
      <span class="dot" :class="summary.tone" />
      <span class="sum">{{ summary.text }}</span>
      <span class="chev">{{ open ? '▾' : '▸' }}</span>
    </button>

    <div v-if="open" class="body">
      <p v-if="error" class="muted small">Status unavailable: {{ error.message }}</p>

      <template v-else-if="health">
        <dl class="metrics">
          <div v-for="r in rows" :key="r.key" class="metric">
            <dt>
              <span class="dot" :class="r.tone" />
              {{ r.label }}
            </dt>
            <dd class="num">{{ r.value }}</dd>
            <p class="note muted small">{{ r.note }}</p>
          </div>
        </dl>

        <div v-if="lastRuns.length" class="runs">
          <h5>Last run</h5>
          <div v-for="r in lastRuns" :key="r.key" class="run">
            <span class="rlabel">{{ r.label }}</span>
            <span class="rcost num">{{ r.cost }}</span>
            <span class="rwhen muted small">{{ r.when }}</span>
            <p class="note muted small">
              {{ r.detail }}<template v-if="r.error"> · failed: {{ r.error }}</template>
            </p>
          </div>
        </div>

        <p v-if="fx" class="muted small fx">
          FX {{ fx.USD }} USD/CAD ({{ fx.USD_date }}) · Bank of Canada, refreshed with fundamentals
        </p>
      </template>

      <p v-else class="muted small">Checking…</p>
    </div>
  </div>
</template>

<style scoped>
.panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-soft);
  font-size: 0.9em;
}
.toggle {
  display: flex;
  gap: 0.5em;
  align-items: center;
  width: 100%;
  padding: 5px 10px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.toggle:hover {
  color: var(--text-h);
}
.sum {
  flex: 1;
}
.chev {
  opacity: 0.6;
}

/* Traffic light. Colour is never the only signal — every dot sits beside the
   number it describes, so this stays readable without colour vision. */
.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border);
}
.dot.ok {
  background: var(--pos);
}
.dot.warn {
  background: #d98324;
}
.dot.bad {
  background: var(--neg);
}
.dot.unknown {
  background: var(--border);
}

.body {
  padding: 2px 10px 10px;
  border-top: 1px solid var(--border);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 10px 18px;
  margin: 10px 0 0;
}
.metric {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 0 8px;
}
.metric dt {
  display: flex;
  gap: 0.45em;
  align-items: center;
  color: var(--text-h);
}
.metric dd {
  margin: 0;
  color: var(--text-h);
  font-family: var(--mono);
}
.note {
  grid-column: 1 / -1;
  margin: 1px 0 0;
  line-height: 1.35;
}

.runs {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.runs h5 {
  margin: 0 0 6px;
  color: var(--text-h);
  font-size: 0.95em;
}
.run {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: baseline;
  gap: 0 10px;
  margin-bottom: 6px;
}
.rcost {
  font-family: var(--mono);
  color: var(--text-h);
}
.fx {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
</style>
