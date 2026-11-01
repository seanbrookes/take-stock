<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  fetchUniverse,
  fetchSectors,
  startRefresh,
  refreshStatus,
  fetchDbStats,
  startFundamentals,
  fundamentalsStatus,
} from '../api/local.js'
import { CATEGORIES } from '../api/classify.js'
import { currency, percent, ratio, perShare, signedPercent, trendClass } from '../analysis/format.js'
import StateBlock from '../components/StateBlock.vue'
import SparkLine from '../components/SparkLine.vue'
import MagnitudeBar from '../components/MagnitudeBar.vue'
import StockRowDetail from '../components/StockRowDetail.vue'
import RowBadges from '../components/RowBadges.vue'
import RefreshPanel from '../components/RefreshPanel.vue'
import ValueGrade from '../components/ValueGrade.vue'
import DebtGrade from '../components/DebtGrade.vue'
import { valuationOf, debtOf, humanSector } from '../analysis/valuation.js'
import { loadAnnotations } from '../stores/annotations.js'
import { listsOnly, tagsOnly, loadLists, state as listState } from '../stores/lists.js'
import { useHistory } from '../composables/useHistory.js'
import { researchUrl } from '../analysis/research-link.js'
import { fetchGroups } from '../api/journal.js'

const route = useRoute()
const router = useRouter()

const rows = ref([])
const sectors = ref([])
const stats = ref(null)
const loading = ref(true)
const error = ref(null)
const refresh = ref({ running: false, done: 0, total: 0 })

/*
 * Market cap range, on a log scale.
 *
 * Caps here span $1M shells to Royal Bank at $416B — six orders of magnitude —
 * so a linear slider would spend 99% of its travel above $4B and be unusable
 * for the small end, which is most of the universe. One decade per 100 units
 * instead: 0 = $1M, 300 = $1B, 600 = $1T. Every position is the same
 * proportional step, which is how you actually think about market cap.
 */
const CAP_FLOOR = 1e6
const CAP_POS_MAX = 600
const posToCap = (pos) => CAP_FLOOR * 10 ** (pos / 100)
const capToPos = (cap) =>
  Math.round(Math.min(Math.max(100 * Math.log10(cap / CAP_FLOOR), 0), CAP_POS_MAX))

/*
 * Thresholds people actually think in, as jumps to a slider position.
 *
 * Rounded down, not to nearest: position 270 evaluates to $501M, so a "$500M+"
 * preset built on it would quietly exclude a company sitting exactly on $500M.
 * Landing just under the label is the harmless direction to miss by.
 */
const stepPos = (cap) => Math.floor(100 * Math.log10(cap / CAP_FLOOR))
const CAP_STEPS = [
  { label: 'Any', lo: 0 },
  { label: '$100M+', lo: stepPos(100e6) },
  { label: '$500M+', lo: stepPos(500e6) },
  { label: '$1B+', lo: stepPos(1e9) },
  { label: '$2B+', lo: stepPos(2e9) },
  { label: '$10B+', lo: stepPos(10e9) },
  { label: '$50B+', lo: stepPos(50e9) },
]

const capLo = ref(route.query.minCap ? capToPos(Number(route.query.minCap)) : 0)
const capHi = ref(route.query.maxCap ? capToPos(Number(route.query.maxCap)) : CAP_POS_MAX)

/** An endpoint parked at its extreme means "no bound", not "$1M" or "$1T". */
const minCap = computed(() => (capLo.value > 0 ? posToCap(capLo.value) : 0))
const maxCap = computed(() => (capHi.value < CAP_POS_MAX ? posToCap(capHi.value) : Infinity))
const capActive = computed(() => capLo.value > 0 || capHi.value < CAP_POS_MAX)

/** Keep the handles from crossing; whichever one moved wins. */
const onCapLo = () => {
  if (capLo.value > capHi.value) capHi.value = capLo.value
}
const onCapHi = () => {
  if (capHi.value < capLo.value) capLo.value = capHi.value
}
const resetCap = () => {
  capLo.value = 0
  capHi.value = CAP_POS_MAX
}
const applyStep = (lo) => {
  capLo.value = lo
  capHi.value = CAP_POS_MAX
}

/** Reads the range back in the units it was set in, not slider positions. */
const capLabel = computed(() => {
  if (!capActive.value) return 'Any size'
  const lo = capLo.value > 0 ? currency(minCap.value) : 'Any'
  const hi = capHi.value < CAP_POS_MAX ? currency(maxCap.value) : 'Any'
  if (capHi.value >= CAP_POS_MAX) return `${lo}+`
  if (capLo.value <= 0) return `Up to ${hi}`
  return `${lo} – ${hi}`
})

const capFillStyle = computed(() => ({
  left: `${(capLo.value / CAP_POS_MAX) * 100}%`,
  right: `${100 - (capHi.value / CAP_POS_MAX) * 100}%`,
}))
const sector = ref(route.query.sector ?? '')
// Defaults to "all" rather than "equity": category is derived from Questrade
// data, so it is null until prices are refreshed — defaulting to equity would
// show an empty screener immediately after a TMX import.
const category = ref(route.query.category ?? '')
const group = ref(route.query.group ?? '')
const groups = ref([])
// Sort lives in the URL alongside the filters, so returning to a screen — via
// the back button or a bookmark — restores the whole view, not just the rows.
const sort = ref(route.query.sort ?? 'market_cap')
const dir = ref(route.query.dir ?? 'desc')

async function load() {
  loading.value = true
  error.value = null
  try {
    const [u, s] = await Promise.all([
      fetchUniverse({
        // Note: no cap bound. The range slider filters client-side, so sending
        // it here would re-query on every drag — and StateBlock swaps the table
        // for a spinner while loading, making the slider jump under the cursor.
        sector: sector.value || undefined,
        category: category.value || undefined,
        group: group.value || undefined,
        sort: sort.value,
        dir: dir.value,
        // Above the ~2,000-issuer universe on purpose. The Company search
        // filters the rows already loaded, so a lower ceiling would make it
        // quietly unable to find anything past the cut — with default filters
        // a limit of 1,000 left 1,018 companies unsearchable.
        limit: 2500,
      }),
      fetchSectors(),
    ])
    groups.value = (await fetchGroups().catch(() => ({ groups: [] }))).groups
    loadAnnotations()
    // symbolId/spark live on the row so sparklines can be filled in place.
    rows.value = u.rows.map((r) => ({
      ...r,
      symbolId: r.symbol_id,
      spark: null,
      sparkChange: null,
      // Computed in SQL so the column can be sorted on; see queryUniverse.
      rangePos: r.range_pos,
    }))
    stats.value = u.stats
    sectors.value = s.sectors
    // Supersedes any sweep still running for the previous filter.
    history.sweep(rows.value)
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

const history = useHistory({ range: '1m', longRange: '5y', concurrency: 4 })

const reloadHistory = () => history.sweep(rows.value, { force: true })

onMounted(async () => {
  // Annotations are their own small payload so badges stay live without
  // re-running the universe query.
  loadAnnotations()
  if (!listState.loaded) loadLists()
  await load()
})

// Keep filters in the URL so a screen can be bookmarked or shared. The cap
// range rides along even though it never reaches the server, so a shared link
// reproduces what the sender was actually looking at.
watch([capLo, capHi, sector, category, group, sort, dir], () => {
  router.replace({
    query: {
      ...(capLo.value ? { minCap: String(Math.round(minCap.value)) } : {}),
      ...(capHi.value < CAP_POS_MAX ? { maxCap: String(Math.round(maxCap.value)) } : {}),
      ...(sector.value ? { sector: sector.value } : {}),
      ...(category.value ? { category: category.value } : {}),
      ...(group.value ? { group: String(group.value) } : {}),
      ...(sort.value !== 'market_cap' ? { sort: sort.value } : {}),
      ...(dir.value !== 'desc' ? { dir: dir.value } : {}),
    },
  })
})

// Only the filters the SQL actually applies trigger a refetch.
watch([sector, category, group, sort, dir], load)

/**
 * The fundamentals sweep, which is a different shape of job from the price
 * refresh: minutes rather than seconds, and bounded by SEC's rate limit rather
 * than Questrade's. Scoped to the current cap filter so it is possible to fill
 * in the large caps without waiting on 1,300 TSXV juniors that mostly do not
 * file with SEC at all.
 */
const fund = ref({ running: false, done: 0, total: 0 })
let fundPoll = null

async function doFundamentals() {
  fund.value = await startFundamentals({ minCap: minCap.value || undefined })
  clearInterval(fundPoll)
  fundPoll = setInterval(async () => {
    fund.value = await fundamentalsStatus()
    if (!fund.value.running) {
      clearInterval(fundPoll)
      stats.value = await fetchDbStats()
      load()
    }
  }, 2000)
}
onUnmounted(() => clearInterval(fundPoll))

let poll = null
async function doRefresh(force = false) {
  refresh.value = await startRefresh(force)
  clearInterval(poll)
  poll = setInterval(async () => {
    refresh.value = await refreshStatus()
    if (!refresh.value.running) {
      clearInterval(poll)
      stats.value = await fetchDbStats()
      load()
    }
  }, 1500)
}
onUnmounted(() => clearInterval(poll))

function sortBy(key) {
  if (sort.value === key) dir.value = dir.value === 'desc' ? 'asc' : 'desc'
  else {
    sort.value = key
    // Value sorts ascending by default: the point of clicking it is to see the
    // cheap end, and a low score is cheap.
    dir.value = ['symbol', 'name', 'value_score', 'debt_score'].includes(key) ? 'asc' : 'desc'
  }
}


/**
 * Find-in-list for the Company column.
 *
 * Filtered client-side rather than by re-querying: StateBlock swaps the whole
 * table for a spinner while loading, so a round trip per keystroke would
 * unmount this input and take the focus with it. Filtering what is already
 * loaded keeps it instant and keeps the caret where it is.
 *
 * Deliberately not in the URL, unlike the other filters. Those define which
 * companies a screen is about; this is a way of finding one inside that screen,
 * and putting it in the address bar would rewrite history on every keystroke.
 */
const nameQuery = ref('')

/**
 * Rows inside the market-cap range, before the name search narrows them.
 *
 * A row with no market cap is dropped as soon as *either* bound is set, since
 * it cannot be shown to satisfy a bound it has no value for. In practice that
 * is almost nothing — queryUniverse coalesces Questrade's cap with TMX's, so
 * all 2,018 rows currently carry one — but the guard matters for a symbol
 * imported before its first price refresh.
 */
const capRows = computed(() => {
  if (!capActive.value) return rows.value
  const lo = minCap.value
  const hi = maxCap.value
  return rows.value.filter((r) => {
    const c = r.market_cap
    return Number.isFinite(c) && c >= lo && c <= hi
  })
})

const visibleRows = computed(() => {
  const q = nameQuery.value.trim().toLowerCase()
  if (!q) return capRows.value
  // Every term must match somewhere, so "canadian rail" finds CNR regardless of
  // word order or what sits between them.
  const terms = q.split(/\s+/)
  return capRows.value.filter((r) => {
    // The exchange suffix is noise when typing a ticker: searching "cnr" should
    // match CNR.TO, and searching "cnr.to" should still work.
    const hay = `${r.name ?? ''} ${r.symbol} ${r.symbol.replace(/\.(TO|VN)$/, '')}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
})

const searching = computed(() => nameQuery.value.trim().length > 0)

/*
 * Windowed rendering.
 *
 * Every row mounts four components — badges, the cap bar, and the two grade
 * badges — so the full universe is roughly 8,000 component instances and 24,000
 * cells, which is a lot of work for rows nobody scrolls to.
 *
 * Windowing rather than virtualising, deliberately. The table is sized by
 * `width: 100%; min-width: max-content` (see style.css), so the browser derives
 * column widths from whatever rows are currently rendered. A virtual list
 * swapping rows in and out during a scroll would recompute those widths
 * continuously and the columns would visibly jitter. A window is stable between
 * clicks, so the widths hold still.
 *
 * All the data stays in memory either way: `visibleRows` searches the whole
 * universe, and only the slice that gets rendered is bounded.
 */
const WINDOW_STEP = 300
const windowSize = ref(WINDOW_STEP)

// Any change to what is being looked at starts the window over — otherwise a
// narrow search inherits a window grown wide by the previous one.
watch([nameQuery, capLo, capHi, sector, category, group, sort, dir], () => {
  windowSize.value = WINDOW_STEP
})

const renderedRows = computed(() => visibleRows.value.slice(0, windowSize.value))
const hiddenCount = computed(() => visibleRows.value.length - renderedRows.value.length)
const showMore = () => (windowSize.value += WINDOW_STEP)
const showAll = () => (windowSize.value = visibleRows.value.length)

const totals = computed(() => {
  const list = visibleRows.value
  const cap = list.reduce((sum, r) => sum + (r.market_cap ?? 0), 0)
  const pes = list.map((r) => r.pe).filter(Number.isFinite).sort((a, b) => a - b)
  return {
    count: list.length,
    cap,
    medianPe: pes.length ? pes[Math.floor(pes.length / 2)] : null,
  }
})

/** Expanded row, by symbol. Opening one closes the previous. */
const expanded = ref(null)
const toggle = (symbol) => (expanded.value = expanded.value === symbol ? null : symbol)

const empty = computed(() => !loading.value && !rows.value.length)
const universeEmpty = computed(() => stats.value && stats.value.universe === 0)

const COLUMNS = [
  { key: 'symbol', label: 'Symbol', align: 'left' },
  { key: 'name', label: 'Company', align: 'left' },
  { key: 'sector', label: 'Sector', align: 'left' },
  { key: 'prev_close', label: 'Last close' },
  { key: 'market_cap', label: 'Market cap' },
  { key: 'pe', label: 'P/E' },
  // One column for valuation, deliberately. The underlying multiples (P/S, P/B,
  // P/FCF, EV/EBITDA) are each too sparse to justify their own column across a
  // universe that is 87% non-SEC-filers; combined into a sector-relative grade
  // they earn a single one. The raw ratios are in the expanded row.
  { key: 'value_score', label: 'Value' },
  // Same treatment for leverage: four sparse columns collapsed into one graded
  // one, with the raw ratios still in the expanded row.
  { key: 'debt_score', label: 'Debt' },
  { key: 'yield', label: 'Yield' },
  // 30-day change loads lazily per row, so the server cannot order by it.
  { key: 'spark', label: '30 days', sortable: false },
  // Same lazy treatment, but a longer horizon. A company with less than five
  // years of history simply draws a shorter line over the data it has, so youth
  // is visible at a glance.
  { key: 'spark_long', label: '5 years', sortable: false },
  { key: 'range_pos', label: '52w pos' },
]
</script>

<template>
  <div class="stack">
    <div class="head">
      <div>
        <h1>Screener</h1>
        <p class="muted sub" v-if="stats">
          {{ stats.priced }} priced of {{ stats.universe }} listings in the local universe
        </p>
      </div>
      <div class="controls">
      <div class="row">
        <button :disabled="history.loading.value" @click="reloadHistory">
          {{
            history.loading.value
              ? `History ${history.done.value}/${history.total.value}…`
              : 'Reload history'
          }}
        </button>
        <button :disabled="refresh.running" @click="doRefresh(false)">
          {{ refresh.running ? `Refreshing ${refresh.done}/${refresh.total}…` : 'Refresh prices' }}
        </button>
        <button
          :disabled="fund.running"
          title="Fetch SEC filings for companies missing them, then regrade. Slow — one filing per company at SEC's rate limit."
          @click="doFundamentals"
        >
          {{ fund.running ? `Fundamentals ${fund.done}/${fund.total}…` : 'Refresh fundamentals' }}
        </button>
      </div>
      <RefreshPanel :min-cap="minCap" :busy="refresh.running || fund.running" />
      </div>
    </div>

    <div v-if="universeEmpty" class="card empty">
      <h2>No universe imported yet</h2>
      <p class="muted">
        Questrade has no screener endpoint and its symbol search cannot be enumerated, so the list
        of TSX companies has to come from a TMX export.
      </p>
      <ol>
        <li>
          Download the listed-company directory from
          <a href="https://www.tsx.com/en/listings/listing-with-us/listed-company-directory" target="_blank" rel="noopener">
            TMX
          </a>
        </li>
        <li><code>npm run import-tmx -- path/to/file.csv</code></li>
        <li>Come back and press <strong>Refresh prices</strong>.</li>
      </ol>
    </div>

    <template v-else>
      <div class="filters card">
        <div class="filter-line">
          <span class="flabel">Market cap</span>
          <button
            v-for="c in CAP_STEPS"
            :key="c.label"
            class="chip"
            :class="{ on: capLo === c.lo && capHi === CAP_POS_MAX }"
            @click="applyStep(c.lo)"
          >
            {{ c.label }}
          </button>

          <div class="cap-slider">
            <span class="cap-readout num">{{ capLabel }}</span>
            <div class="cap-rail">
              <div class="cap-track" />
              <div class="cap-fill" :style="capFillStyle" />
              <!-- Two overlaid ranges rather than one control: the platform has
                   no dual-thumb input, and this keeps both handles keyboard-
                   reachable without a dependency. -->
              <input
                v-model.number="capLo"
                type="range"
                min="0"
                :max="CAP_POS_MAX"
                step="1"
                class="cap-input"
                aria-label="Minimum market cap"
                @input="onCapLo"
              />
              <input
                v-model.number="capHi"
                type="range"
                min="0"
                :max="CAP_POS_MAX"
                step="1"
                class="cap-input"
                aria-label="Maximum market cap"
                @input="onCapHi"
              />
            </div>
            <button v-if="capActive" class="linkish" @click="resetCap">reset</button>
          </div>
        </div>

        <div class="filter-line">
          <span class="flabel">Type</span>
          <button class="chip" :class="{ on: category === '' }" @click="category = ''">All</button>
          <button
            v-for="c in CATEGORIES"
            :key="c.id"
            class="chip"
            :class="{ on: category === c.id }"
            @click="category = c.id"
          >
            {{ c.label }}
          </button>
        </div>

        <div v-if="groups.length" class="filter-line">
          <span class="flabel">My lists</span>
          <button class="chip" :class="{ on: group === '' }" @click="group = ''">All</button>
          <button
            v-for="g in listsOnly"
            :key="g.id"
            class="chip"
            :class="{ on: String(group) === String(g.id) }"
            @click="group = String(g.id)"
          >
            {{ g.name }} <span class="chip-n">{{ g.members }}</span>
          </button>
        </div>

        <div v-if="tagsOnly.length" class="filter-line">
          <span class="flabel">Tags</span>
          <button
            v-for="t in tagsOnly"
            :key="t.id"
            class="chip"
            :class="{ on: String(group) === String(t.id) }"
            @click="group = String(group) === String(t.id) ? '' : String(t.id)"
          >
            {{ t.name }} <span class="chip-n">{{ t.members }}</span>
          </button>
        </div>

        <div class="filter-line">
          <span class="flabel">Sector</span>
          <button class="chip" :class="{ on: sector === '' }" @click="sector = ''">All</button>
          <button
            v-for="s in sectors"
            :key="s.sector"
            class="chip"
            :class="{ on: sector === s.sector }"
            @click="sector = s.sector"
          >
            {{ humanSector(s.sector) }} <span class="chip-n">{{ s.count }}</span>
          </button>
        </div>
      </div>

      <StateBlock :loading="loading" :error="error" :empty="empty"
        empty-text="No listings match this screen. Try a lower market cap, or refresh prices."
        label="Screening…" @retry="load">
        <div class="stack">
          <p class="muted tiny">
            <template v-if="searching">
              <strong>{{ totals.count }}</strong> of {{ capRows.length.toLocaleString() }} match
              “{{ nameQuery.trim() }}”
              <button class="linkish" @click="nameQuery = ''">clear</button> ·
            </template>
            <template v-else>{{ totals.count.toLocaleString() }} companies · </template>
            <template v-if="capActive && !searching">
              {{ capLabel }} of {{ rows.length.toLocaleString() }} ·
            </template>
            <!-- The window is a rendering limit, not a filter, so it is stated
                 separately: the totals below still describe every match. -->
            <template v-if="hiddenCount">
              showing {{ renderedRows.length.toLocaleString() }} ·
            </template>
            {{ currency(totals.cap) }} combined ·
            median P/E {{ ratio(totals.medianPe) }} · market-cap bars are log-scaled
            <template v-if="history.loading.value">
              · loading history {{ history.done.value }}/{{ history.total.value }}
            </template>
            <template v-else-if="history.total.value">
              · history: {{ history.fromCache.value }} cached,
              {{ history.total.value - history.fromCache.value - history.failed.value }} fetched<template
                v-if="history.failed.value"
              >, {{ history.failed.value }} unavailable</template><template v-if="history.skipped.value">
                — charts cover the largest {{ history.total.value }};
                {{ history.skipped.value }} smaller listings skipped, narrow the filter or press
                Reload history</template>
            </template>
          </p>

          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th
                    v-for="c in COLUMNS"
                    :key="c.key"
                    :class="[c.align === 'left' ? '' : 'num', c.sortable === false ? '' : 'sortable']"
                    :title="c.sortable === false ? 'Loads per row, so cannot be sorted' : `Sort by ${c.label}`"
                    @click="c.sortable === false || sortBy(c.key)"
                  >
                    {{ c.label }}
                    <span v-if="sort === c.key" class="arrow">{{ dir === 'asc' ? '↑' : '↓' }}</span>
                    <!-- Typing must not re-sort the table, so every interaction
                         inside the input is kept off the th's click handler. -->
                    <input
                      v-if="c.key === 'name'"
                      v-model="nameQuery"
                      type="search"
                      class="col-search"
                      placeholder="Search name or ticker…"
                      aria-label="Search companies by name or ticker"
                      @click.stop
                      @keydown.stop
                      @keydown.esc="nameQuery = ''"
                    />
                  </th>
                  <th class="actions-cell"></th>
                </tr>
              </thead>
              <tbody>
                <!-- A search that matches nothing is a different situation from
                     a screen that matches nothing, and needs a different way
                     out — clear the search, not widen the filters. -->
                <tr v-if="!visibleRows.length && rows.length" class="no-match">
                  <td :colspan="COLUMNS.length + 1" class="muted">
                    <template v-if="searching">
                      No company matches “{{ nameQuery.trim() }}”
                      <template v-if="capActive"> within {{ capLabel }}</template>.
                      <button class="linkish" @click="nameQuery = ''">Clear search</button>
                    </template>
                    <template v-else>
                      No company on this screen falls within {{ capLabel }}.
                      <button class="linkish" @click="resetCap">Reset market cap</button>
                    </template>
                  </td>
                </tr>
                <template v-for="r in renderedRows" :key="r.symbol">
                <tr :class="{ open: expanded === r.symbol }">
                  <td>
                    <span class="tag">{{ r.symbol.replace(/\.(TO|VN)$/, '') }}</span>
                    <RowBadges :symbol="r.symbol" />
                  </td>
                  <td class="cname">{{ r.name }}</td>
                  <td class="muted small">{{ humanSector(r.sector) }}</td>
                  <td class="num">
                    {{ perShare(r.prev_close) }}
                    <span v-if="r.prev_close && r.currency && r.currency !== 'CAD'" class="muted cur">
                      {{ r.currency }}
                    </span>
                  </td>
                  <td class="num cap-cell">
                    <span class="cap-value">{{ currency(r.market_cap) }}</span>
                    <MagnitudeBar :value="r.market_cap" />
                  </td>
                  <td class="num">{{ ratio(r.pe) }}</td>
                  <td class="num">
                    <ValueGrade :valuation="valuationOf(r)" :priced="Boolean(r.market_cap)" />
                  </td>
                  <td class="num"><DebtGrade :debt="debtOf(r)" /></td>
                  <td class="num">{{ r.yield ? percent(r.yield / 100) : '—' }}</td>
                  <td class="num spark" :class="trendClass(r.sparkChange)">
                    <SparkLine v-if="r.spark" :values="r.spark" :width="64" :height="18" />
                    <span v-else-if="history.loading.value" class="muted pending">·</span>
                    <span v-else class="muted pending">—</span>
                    <span v-if="r.sparkChange != null" class="s30">{{ signedPercent(r.sparkChange) }}</span>
                  </td>
                  <td
                    class="num spark-long"
                    :class="trendClass(r.sparkLongChange)"
                    :title="r.sparkLong?.length > 1
                      ? `${r.sparkLong.length} weeks of history`
                      : 'No long-run history loaded'"
                  >
                    <SparkLine
                      v-if="r.sparkLong"
                      :values="r.sparkLong"
                      :width="96"
                      :height="18"
                      :reference="260"
                    />
                    <span v-else-if="history.longLoading.value" class="muted pending">·</span>
                    <span v-else class="muted pending">—</span>
                  </td>
                  <td class="num">
                    <span v-if="r.rangePos != null" class="range" :title="`${perShare(r.low52)} – ${perShare(r.high52)}`">
                      <span class="range-bar">
                        <i :style="{ left: `${Math.min(Math.max(r.rangePos, 0), 1) * 100}%` }" />
                      </span>
                    </span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td class="num actions-cell">
                    <div class="actions">
                    <button class="disclose" @click="toggle(r.symbol)">
                      {{ expanded === r.symbol ? '▾' : '▸' }} Details
                    </button>
                    <a
                      :href="researchUrl(r)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="small research"
                      :title="`Research ${r.name} in Google AI Mode`"
                      @click.stop
                    >
                      Research ↗
                    </a>
                    </div>
                  </td>
                </tr>

                <tr v-if="expanded === r.symbol" class="detail-row">
                  <td :colspan="COLUMNS.length + 1">
                    <StockRowDetail
                      :symbol="r.symbol"
                      :symbol-id="r.symbolId"
                      :name="r.name"
                      :sector="r.sector"
                      :currency-code="r.currency"
                      :valuation="valuationOf(r)"
                      :debt="debtOf(r)"
                    />
                  </td>
                </tr>
                </template>

                <!-- Sits inside the scroll container so it meets you where you
                     ran out of rows, rather than below the table where you
                     would have to scroll back out to find it. -->
                <tr v-if="hiddenCount" class="more-row">
                  <td :colspan="COLUMNS.length + 1">
                    <div class="more-inner">
                      <button class="more" @click="showMore">
                        Show {{ Math.min(WINDOW_STEP, hiddenCount) }} more
                      </button>
                      <span class="muted small">
                        {{ hiddenCount.toLocaleString() }}
                        {{ searching ? 'more matches' : 'more companies' }} loaded but not drawn
                        <button class="linkish" @click="showAll">show all</button>
                      </span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </StateBlock>
    </template>
  </div>
</template>

<style scoped>
/* Height budget for the sticky-header scroll area: window minus the toolbar,
   filters and summary line above it. */
.stack {
  --table-max: calc(100svh - 330px);
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.sub {
  font-size: 13px;
  margin-top: 6px;
}

/* Buttons and the status panel are one unit: the panel says what pressing them
   will cost, so it is sized to them rather than to the page. */
.controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: stretch;
  min-width: 340px;
  max-width: 520px;
}
.controls .row {
  justify-content: flex-end;
}

.filters {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.filter-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.flabel {
  font-size: 12px;
  width: 88px;
  flex-shrink: 0;
  color: var(--text);
}

.chip {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 20px;
  background: var(--bg);
}
.chip.on {
  color: var(--accent);
  border-color: var(--accent-border);
  background: var(--accent-bg);
}
.chip-n {
  opacity: 0.6;
  margin-left: 4px;
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
  max-width: 70ch;
}
.empty ol {
  margin: 0;
  padding-left: 20px;
  line-height: 190%;
  font-size: 14px;
}

/* Sits under the column label rather than beside it, so adding it does not
   widen the Company column or shift every column to its right. */
.col-search {
  display: block;
  width: 100%;
  min-width: 130px;
  margin-top: 4px;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-h);
  font: inherit;
  font-size: 0.92em;
  font-weight: 400;
}
.col-search:focus {
  outline: none;
  border-color: var(--accent);
}
.col-search::placeholder {
  color: var(--text);
  opacity: 0.6;
}

/* Dual-handle range.
   Two <input type=range> stacked on one rail, because the platform has no
   two-thumb control. The inputs themselves ignore the pointer so clicks fall
   through to whichever thumb is under the cursor rather than always hitting
   the input stacked on top; only the thumbs take pointer events back. */
.cap-slider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: 4px;
}
.cap-readout {
  min-width: 8.5em;
  font-family: var(--mono);
  font-size: 0.85em;
  color: var(--text-h);
  white-space: nowrap;
}
.cap-rail {
  position: relative;
  width: 180px;
  height: 18px;
}
.cap-track,
.cap-fill {
  position: absolute;
  top: 7px;
  height: 4px;
  border-radius: 2px;
}
.cap-track {
  left: 0;
  right: 0;
  background: var(--border);
}
.cap-fill {
  background: var(--accent);
  opacity: 0.75;
}
.cap-input {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 18px;
  margin: 0;
  background: none;
  pointer-events: none;
  -webkit-appearance: none;
  appearance: none;
}
.cap-input:focus-visible {
  outline: none;
}
.cap-input::-webkit-slider-thumb {
  pointer-events: auto;
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  border: 2px solid var(--bg);
  border-radius: 50%;
  background: var(--accent);
  cursor: grab;
}
.cap-input::-moz-range-thumb {
  pointer-events: auto;
  width: 13px;
  height: 13px;
  border: 2px solid var(--bg);
  border-radius: 50%;
  background: var(--accent);
  cursor: grab;
}
.cap-input:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px var(--accent-bg);
}
.cap-input:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 3px var(--accent-bg);
}

.no-match td {
  padding: 28px 12px;
  text-align: center;
}

.more-row td {
  padding: 14px 12px;
}
/* Flex lives on an inner div, never the cell: `display: flex` on a <td>
   overrides `table-cell` and the colspan stops spanning. */
.more-inner {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: baseline;
  justify-content: center;
}
.more {
  padding: 4px 12px;
}

/* A button that reads as a link — used inline in prose where a button shape
   would be too heavy. */
.linkish {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

th.sortable {
  cursor: pointer;
  user-select: none;
}
th.sortable:hover {
  color: var(--accent);
}
.arrow {
  color: var(--accent);
}

.cname {
  white-space: normal;
  max-width: 320px;
  font-size: 13px;
}
.small {
  font-size: 12px;
}
.tiny {
  font-size: 12px;
}

.spark {
  min-width: 108px;
  white-space: nowrap;
}
.spark svg {
  vertical-align: middle;
}
.spark-long {
  min-width: 102px;
  white-space: nowrap;
}
.spark-long svg {
  vertical-align: middle;
}
.s30 {
  margin-left: 6px;
  font-size: 11px;
}
.pending {
  opacity: 0.4;
}

.cur {
  font-size: 10px;
  margin-left: 3px;
}

.cap-cell {
  white-space: nowrap;
}

.disclose {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--accent);
  white-space: nowrap;
}
.disclose:hover {
  text-decoration: underline;
}

tr.open {
  background: var(--bg-soft);
}
.detail-row > td {
  background: var(--bg-soft);
  white-space: normal;
  padding: 0;
}

.notes-badge {
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 11px;
  font-family: var(--mono);
}

/* The flex container must be *inside* the cell. Setting display:flex on a <td>
   takes it out of table layout, so the browser stops allocating width for the
   column and the content is clipped at the table edge instead of widening it. */
.actions-cell {
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  white-space: nowrap;
}
.research {
  color: var(--text);
}
.research:hover {
  color: var(--accent);
}

.range {
  display: inline-block;
  width: 56px;
}
.range-bar {
  position: relative;
  display: block;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(to right, var(--neg), var(--border), var(--pos));
  opacity: 0.55;
}
.range-bar i {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 10px;
  background: var(--text-h);
  border-radius: 1px;
}
</style>
