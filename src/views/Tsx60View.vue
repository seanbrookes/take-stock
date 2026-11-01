<script setup>
import { computed, ref, shallowRef, watch, onMounted } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { TSX60, TSX60_REVIEWED } from '../data/tsx60.js'
import { fetchUniverse } from '../api/local.js'
import { fetchSymbolsByNames, fetchQuotes } from '../api/questrade.js'
import { useHistory } from '../composables/useHistory.js'
import { currency, percent, ratio, perShare, signedPercent } from '../analysis/format.js'
import SparkLine from '../components/SparkLine.vue'
import MagnitudeBar from '../components/MagnitudeBar.vue'
import StateBlock from '../components/StateBlock.vue'
import StockRowDetail from '../components/StockRowDetail.vue'
import RowBadges from '../components/RowBadges.vue'
import ValueGrade from '../components/ValueGrade.vue'
import DebtGrade from '../components/DebtGrade.vue'
import { valuationOf, debtOf } from '../analysis/valuation.js'
import { loadAnnotations } from '../stores/annotations.js'
import { researchUrl } from '../analysis/research-link.js'

const route = useRoute()
const router = useRouter()

const loading = ref(true)
const error = shallowRef(null)
const rows = ref([])
const expanded = ref(null)

/**
 * Same cached loader the Screener uses. Previously this view called Questrade
 * directly for all 60 charts on every visit, ignoring the SQLite candle cache —
 * 60 API calls to redraw sparklines that were already on disk.
 */
const history = useHistory({ range: '1m', concurrency: 4 })
const reloadHistory = () => history.sweep(rows.value, { force: true })
// Sort lives in the URL so returning to the view restores it, matching the
// Screener — the back button used to silently reset it.
const sortKey = ref(route.query.sort ?? 'marketCap')
const sortDir = ref(route.query.dir === 'asc' ? 1 : -1)
const filter = ref('')

/** Where the constituent list came from, shown in the footer. */
const membershipSource = ref('curated list')

/**
 * Prefer TMX's own index-membership flag over the hand-curated list. Checked
 * against it, the curated list had three companies missing, five that are not
 * members, and several wrong share classes — so it is only a fallback for a
 * fresh install with nothing imported yet.
 */
async function constituents() {
  try {
    const { rows } = await fetchUniverse({ indexName: '60.0', limit: 100 })
    if (rows.length) {
      membershipSource.value = `TMX index data (${rows.length} constituents)`
      // The valuation grade rides along on this query — it is a LEFT JOIN in
      // queryUniverse. Carried through rather than refetched so the letter here
      // is byte-for-byte the one the Screener shows.
      return rows.map((r) => ({
        symbol: r.symbol,
        name: r.name,
        valuation: valuationOf(r),
        debt: debtOf(r),
      }))
    }
  } catch {
    // No database yet, or nothing imported — fall through.
  }
  membershipSource.value = 'curated fallback list — import TMX data for the real index'
  return TSX60
}

async function load() {
  loading.value = true
  error.value = null

  try {
    const members = await constituents()
    // One request for all snapshots, one for all live quotes.
    const symbols = await fetchSymbolsByNames(members.map((c) => c.symbol))
    const byName = new Map(symbols.map((s) => [s.symbol, s]))
    const ids = symbols.map((s) => s.symbolId)
    const quotes = await fetchQuotes(ids)
    const byId = new Map(quotes.map((q) => [q.symbolId, q]))

    rows.value = members.map((c) => {
      const s = byName.get(c.symbol)
      if (!s) {
        return { symbol: c.symbol, name: c.name, missing: true, valuation: c.valuation ?? null, debt: c.debt ?? null }
      }
      const q = byId.get(s.symbolId) ?? {}
      const last = q.lastTradePrice ?? s.prevDayClosePrice
      const prev = s.prevDayClosePrice
      const range = s.highPrice52 - s.lowPrice52

      return {
        symbol: s.symbol,
        name: c.name,
        symbolId: s.symbolId,
        sector: s.industrySector ?? '',
        currency: s.currency,
        last,
        dayChange: prev && last ? (last - prev) / prev : null,
        marketCap: s.marketCap,
        pe: s.pe || null,
        eps: s.eps,
        yield: s.yield ? s.yield / 100 : null,
        dividend: s.dividend,
        high52: s.highPrice52,
        low52: s.lowPrice52,
        // Where the price sits in its 52-week band: 0 = at the low, 1 = at the high.
        rangePos: range > 0 && last ? (last - s.lowPrice52) / range : null,
        relVolume: s.averageVol3Months ? (q.volume ?? 0) / s.averageVol3Months : null,
        volume: q.volume,
        open: q.openPrice,
        dayHigh: q.highPrice,
        dayLow: q.lowPrice,
        prevClose: prev,
        avgVol: s.averageVol3Months,
        shares: s.outstandingShares,
        valuation: c.valuation ?? null,
        debt: c.debt ?? null,
        // Flattened onto the row because sorting here is client-side and keys
        // off a top-level property. Ascending is cheapest-first, as in the
        // Screener; ungraded rows sort last either way.
        valueScore: c.valuation?.score ?? null,
        debtScore: c.debt?.score ?? null,
        spark: null,
        sparkChange: null,
      }
    })

    loading.value = false

    // Served from the SQLite cache where possible; only misses hit Questrade.
    history.sweep(rows.value)
  } catch (err) {
    error.value = err
    loading.value = false
  }
}

onMounted(() => {
  loadAnnotations()
  load()
})

/** Questrade returns PascalCase sectors ("ConsumerDefensive"). */
const humanizeSector = (s) =>
  s ? s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^Basic Materials$/, 'Materials') : '—'

const sectorFilter = ref([])

/** Sectors present, with weight — the TSX is famously concentrated. */
const sectors = computed(() => {
  const map = new Map()
  for (const r of rows.value) {
    const id = r.sector || ''
    if (!map.has(id)) map.set(id, { id, label: humanizeSector(id), count: 0, cap: 0 })
    const e = map.get(id)
    e.count++
    e.cap += r.marketCap ?? 0
  }
  const total = [...map.values()].reduce((s, e) => s + e.cap, 0) || 1
  return [...map.values()]
    .map((e) => ({ ...e, weight: e.cap / total }))
    .sort((a, b) => b.cap - a.cap)
})

function toggleSector(id) {
  const i = sectorFilter.value.indexOf(id)
  if (i >= 0) sectorFilter.value.splice(i, 1)
  else sectorFilter.value.push(id)
}

const COLUMNS = [
  { key: 'symbol', label: 'Symbol', align: 'left' },
  { key: 'sector', label: 'Sector', align: 'left' },
  { key: 'last', label: 'Last' },
  { key: 'prevClose', label: 'Last close' },
  { key: 'dayChange', label: 'Day' },
  { key: 'sparkChange', label: '30 days', sortable: false },
  { key: 'marketCap', label: 'Mkt cap' },
  { key: 'pe', label: 'P/E' },
  // Same column, same meaning, same position relative to P/E as the Screener.
  { key: 'valueScore', label: 'Value' },
  { key: 'debtScore', label: 'Debt' },
  { key: 'yield', label: 'Yield' },
  { key: 'rangePos', label: '52w pos' },
  { key: 'relVolume', label: 'Rel vol' },
]

function sortBy(key) {
  if (sortKey.value === key) sortDir.value *= -1
  else {
    sortKey.value = key
    // Value ascends by default — clicking it means you want the cheap end.
    sortDir.value = ['symbol', 'valueScore', 'debtScore'].includes(key) ? 1 : -1
  }
}

watch([sortKey, sortDir], () => {
  router.replace({
    query: {
      ...(sortKey.value !== 'marketCap' ? { sort: sortKey.value } : {}),
      ...(sortDir.value > 0 ? { dir: 'asc' } : {}),
    },
  })
})

const visible = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const sectorSet = new Set(sectorFilter.value)

  const list = rows.value.filter((r) => {
    if (sectorSet.size && !sectorSet.has(r.sector || '')) return false
    if (!q) return true
    return (
      r.symbol.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      humanizeSector(r.sector).toLowerCase().includes(q)
    )
  })

  const key = sortKey.value
  return list.sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    // Rows still missing a value sort last regardless of direction, so a
    // half-loaded sparkline column doesn't shuffle the table's top.
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir.value
    return (av - bv) * sortDir.value
  })
})

/**
 * Index-level context. Computed over the *visible* rows so that filtering to a
 * sector gives you that sector's median P/E and yield rather than the index's.
 */
const summary = computed(() => {
  const list = visible.value
  if (!list.length) return null
  const live = list.filter((r) => Number.isFinite(r.dayChange))
  const median = (arr) => {
    const s = arr.filter(Number.isFinite).sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length / 2)] : null
  }
  return {
    count: list.length,
    up: live.filter((r) => r.dayChange > 0).length,
    down: live.filter((r) => r.dayChange < 0).length,
    caps: list.reduce((sum, r) => sum + (r.marketCap ?? 0), 0),
    medianPe: median(list.map((r) => r.pe)),
    medianYield: median(list.map((r) => r.yield)),
  }
})

const toggle = (symbol) => (expanded.value = expanded.value === symbol ? null : symbol)
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '')
</script>

<template>
  <div class="stack">
    <div class="head">
      <div>
        <h1>TSX 60</h1>
        <p class="muted sub">
          {{ rows.length }} constituents · live prices from Questrade · via {{ membershipSource }}
        </p>
      </div>
      <div class="row">
        <button :disabled="history.loading.value || !rows.length" @click="reloadHistory">
          {{
            history.loading.value
              ? `History ${history.done.value}/${history.total.value}…`
              : 'Reload history'
          }}
        </button>
        <button :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      </div>
    </div>

    <StateBlock :loading="loading" :error="error" label="Loading TSX 60…" @retry="load">
      <div class="stack">
        <div v-if="summary" class="row summary">
          <span><strong>{{ summary.count }}</strong> shown</span>
          <span><strong class="pos">{{ summary.up }}</strong> up</span>
          <span><strong class="neg">{{ summary.down }}</strong> down</span>
          <span class="muted">Cap {{ currency(summary.caps) }}</span>
          <span class="muted">Median P/E {{ ratio(summary.medianPe) }}</span>
          <span class="muted">Median yield {{ percent(summary.medianYield) }}</span>
          <input v-model="filter" type="search" placeholder="Filter by name…" />
        </div>

        <div class="sectors">
          <button
            v-for="s in sectors"
            :key="s.id"
            class="chip"
            :class="{ on: sectorFilter.includes(s.id) }"
            :title="`${s.count} companies · ${percent(s.weight)} of index market cap`"
            @click="toggleSector(s.id)"
          >
            {{ s.label }}
            <span class="chip-n">{{ s.count }}</span>
            <span class="weight" :style="{ width: `${(s.weight * 100).toFixed(1)}%` }" />
          </button>
          <button v-if="sectorFilter.length" class="chip clear" @click="sectorFilter = []">
            Clear
          </button>
        </div>

        <p v-if="history.loading.value" class="muted tiny">
          Loading price history… {{ history.done.value }}/{{ history.total.value }}
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
                  <span v-if="sortKey === c.key" class="arrow">{{ sortDir > 0 ? '↑' : '↓' }}</span>
                </th>
                <th class="actions-cell"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="r in visible" :key="r.symbol">
                <tr class="clickable" :class="{ open: expanded === r.symbol }" @click="toggle(r.symbol)">
                  <td>
                    <span class="tag">{{ r.symbol.replace('.TO', '') }}</span>
                    <RowBadges :symbol="r.symbol" />
                    <span class="cname">{{ r.name }}</span>
                  </td>
                  <td>
                    <span class="sector-cell muted">{{ humanizeSector(r.sector) }}</span>
                  </td>
                  <td class="num">{{ perShare(r.last) }}</td>
                  <td class="num muted">{{ perShare(r.prevClose) }}</td>
                  <td class="num" :class="cls(r.dayChange)">{{ signedPercent(r.dayChange) }}</td>
                  <td class="num spark" :class="cls(r.sparkChange)">
                    <SparkLine v-if="r.spark" :values="r.spark" :width="70" :height="20" />
                    <span class="s30">{{ signedPercent(r.sparkChange) }}</span>
                  </td>
                  <td class="num cap-cell">
                    <span>{{ currency(r.marketCap) }}</span>
                    <MagnitudeBar :value="r.marketCap" />
                  </td>
                  <td class="num">{{ ratio(r.pe) }}</td>
                  <td class="num">
                    <ValueGrade :valuation="r.valuation" :priced="Boolean(r.marketCap)" />
                  </td>
                  <td class="num"><DebtGrade :debt="r.debt" /></td>
                  <td class="num">{{ percent(r.yield) }}</td>
                  <td class="num">
                    <span class="range" :title="`${perShare(r.low52)} – ${perShare(r.high52)}`">
                      <span class="range-bar">
                        <i v-if="r.rangePos != null" :style="{ left: `${Math.min(Math.max(r.rangePos, 0), 1) * 100}%` }" />
                      </span>
                    </span>
                  </td>
                  <td class="num" :class="r.relVolume > 1.5 ? 'pos' : ''">{{ ratio(r.relVolume) }}</td>
                  <td class="num actions-cell">
                    <div class="actions">
                    <button class="disclose" @click.stop="toggle(r.symbol)">
                      {{ expanded === r.symbol ? '▾' : '▸' }} Details
                    </button>
                    <a
                      :href="researchUrl({ symbol: r.symbol, name: r.name, sector: r.sector })"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="full research"
                      :title="`Research ${r.name} in Google AI Mode`"
                      @click.stop
                    >Research ↗</a>
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
                      :valuation="r.valuation"
                      :debt="r.debt"
                    />
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <p class="muted tiny">
          Membership comes from the TMX issuer reports once imported; otherwise from a curated
          fallback list (reviewed {{ TSX60_REVIEWED }}) that is known to be imperfect. Prices in CAD.
        </p>
      </div>
    </StateBlock>
  </div>
</template>

<style scoped>
/* Height budget for the sticky-header scroll area: window minus the toolbar,
   filters and summary line above it. */
.stack {
  --table-max: calc(100svh - 300px);
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

.summary {
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.summary input {
  margin-left: auto;
  min-width: 200px;
  padding: 5px 10px;
  font-size: 13px;
}

.tiny {
  font-size: 12px;
}

.sectors {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  position: relative;
  overflow: hidden;
  padding: 4px 10px;
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
  margin-left: 6px;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

/* A sliver of fill showing the sector's share of index market cap — the TSX
   is heavily concentrated in financials and energy, which is worth seeing. */
.weight {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent);
  opacity: 0.5;
}

.chip.clear {
  color: var(--text);
}

.cap-cell {
  white-space: nowrap;
}

.sector-cell {
  font-size: 12px;
  white-space: nowrap;
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

.clickable {
  cursor: pointer;
}
tr.open {
  background: var(--bg-soft);
}

.cname {
  margin-left: 8px;
  font-size: 13px;
}

.spark {
  min-width: 120px;
}
.spark svg {
  vertical-align: middle;
}
.s30 {
  margin-left: 8px;
  font-size: 12px;
}

.range {
  display: inline-block;
  width: 62px;
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

.detail-row > td {
  background: var(--bg-soft);
  white-space: normal;
  padding: 0;
}

.full {
  font-size: 12px;
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

.actions-cell {
  white-space: nowrap;
}
/* flex belongs inside the cell — see ScreenerView for why. */
.actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.research {
  color: var(--text);
}
.research:hover {
  color: var(--accent);
}
</style>
