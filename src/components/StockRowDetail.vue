<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { fetchSymbolsByNames, findSecFiler } from '../api/questrade.js'
import { fetchCompanyFactsOrNull } from '../api/sec.js'
import { computeFundamentals, computeTTM } from '../analysis/metrics.js'
import { fetchHistory } from '../composables/useHistory.js'
import { researchUrl, liveQuoteUrl } from '../analysis/research-link.js'
import { currency, percent, ratio, perShare, shares, signedPercent } from '../analysis/format.js'
import PriceChart from './PriceChart.vue'
import ListsButton from './ListsButton.vue'
import NotesPanel from './NotesPanel.vue'
import { annotationsFor } from '../stores/annotations.js'
import { humanSector } from '../analysis/valuation.js'

/**
 * Expanded row: the stock page's Prices + Overview, inline.
 *
 * Exists so following a company does not mean leaving the list. Navigating away
 * and coming back re-runs the query and discards sort, filters and scroll
 * position — the context you built to find this company in the first place.
 *
 * Everything loads on expand, never with the table.
 */
const props = defineProps({
  symbol: { type: String, required: true },
  symbolId: { type: Number, default: null },
  name: { type: String, default: '' },
  sector: { type: String, default: '' },
  /**
   * Currency CODE. Named `currencyCode` because this file also imports a
   * `currency()` formatter, and in a template the import shadows a same-named
   * prop — which silently passed the function itself and rendered its source
   * into the chart tooltip.
   */
  currencyCode: { type: String, default: '' },
  /**
   * The stored valuation row, passed down rather than refetched: the screener
   * query already joined it, and the grade must match the letter in the table
   * exactly. Recomputing here from live figures could disagree with it.
   */
  valuation: { type: Object, default: null },
  /** The stored debt row, same reasoning as valuation. */
  debt: { type: Object, default: null },
})

const RANGES = ['1d', '5d', '1m', '6m', '1y', '5y']
const range = ref('1y')

/**
 * Tabs inside the row, so writing a note or filing a company never costs you
 * the list you were reading. Navigating out and back re-runs the query and
 * discards sort, filters and scroll — the context that got you here.
 */
const tab = ref('overview')
const marks = computed(() => annotationsFor(props.symbol))

const candles = ref([])
const snapshot = ref(null)
const fundamentals = ref(null)
const ttm = ref(null)
const filer = ref(null)
const loadingChart = ref(true)
const loadingFacts = ref(true)
const error = ref(null)

async function loadChart() {
  if (!props.symbolId) {
    loadingChart.value = false
    return
  }
  loadingChart.value = true
  try {
    const res = await fetchHistory(props.symbolId, range.value)
    candles.value = res.candles ?? []
  } catch (err) {
    error.value = err
  } finally {
    loadingChart.value = false
  }
}

async function loadRest() {
  try {
    const [detail] = await fetchSymbolsByNames([props.symbol])
    snapshot.value = detail ?? null

    const match = await findSecFiler({
      symbol: props.symbol,
      description: props.name || detail?.description || props.symbol,
    })
    filer.value = match
    if (match) {
      const facts = await fetchCompanyFactsOrNull(match.cik)
      if (facts) {
        fundamentals.value = computeFundamentals(facts, { period: 'annual' })
        ttm.value = computeTTM(facts)
      }
    }
  } catch (err) {
    error.value = err
  } finally {
    loadingFacts.value = false
  }
}

onMounted(() => {
  loadChart()
  loadRest()
})
watch(range, loadChart)

const chartChange = computed(() => {
  const c = candles.value
  if (c.length < 2) return null
  const first = c[0].close
  return first ? (c.at(-1).close - first) / first : null
})

const market = computed(() => {
  const s = snapshot.value
  if (!s) return []
  return [
    ['Last close', perShare(s.prevDayClosePrice)],
    ['52-week', `${perShare(s.lowPrice52)} – ${perShare(s.highPrice52)}`],
    ['Market cap', currency(s.marketCap)],
    ['P/E', ratio(s.pe || null)],
    ['EPS', perShare(s.eps)],
    ['Dividend', s.dividend ? `${perShare(s.dividend)} (${percent((s.yield ?? 0) / 100)})` : '—'],
    ['Shares out', shares(s.outstandingShares)],
    ['Avg vol (3m)', shares(s.averageVol3Months)],
    ['Exchange', `${s.listingExchange ?? '—'} · ${s.currency ?? ''}`],
    ['Sector', s.industrySector || props.sector || '—'],
  ]
})

const metrics = computed(() => {
  const f = fundamentals.value
  if (!f) return []
  const d = (id) => f.derived.find((x) => x.id === id)?.value
  const t = ttm.value
  const fcf = t?.operatingCashFlow && t?.capex ? t.operatingCashFlow.val - t.capex.val : null
  const growth = f.growth.find((g) => g.id === 'revenue')

  return [
    ['Revenue (TTM)', currency(t?.revenue?.val ?? f.values.revenue)],
    ['Revenue growth', signedPercent(growth?.yoy)],
    ['Free cash flow', currency(fcf ?? d('fcf'))],
    ['Gross margin', percent(d('grossMargin'))],
    ['Operating margin', percent(d('operatingMargin'))],
    ['Net margin', percent(d('netMargin'))],
    ['ROIC', percent(d('roic'))],
    ['ROE', percent(d('roe'))],
    ['Debt / equity', ratio(d('debtToEquity'))],
    ['Net debt / EBITDA', ratio(d('netDebtToEbitda'))],
    ['Interest coverage', ratio(d('interestCoverage'))],
    ['Current ratio', ratio(d('currentRatio'))],
    ['EBITDA', currency(d('ebitda'))],
  ]
})

/**
 * The multiples behind the grade.
 *
 * Shown as the raw ratios rather than the percentiles, because the percentile
 * is only meaningful against the peer set while the ratio is something you can
 * carry to another source and check.
 */
const valuationRows = computed(() => {
  const v = props.valuation
  if (!v?.grade) return []
  return [
    ['P/E', ratio(v.pe)],
    ['P/S', ratio(v.ps)],
    ['P/B', ratio(v.pb)],
    ['P/FCF', ratio(v.pfcf)],
    ['EV/EBITDA', ratio(v.ev_ebitda)],
  ]
})

/** The four leverage metrics behind the debt grade, including for excluded rows. */
const debtRows = computed(() => {
  const d = props.debt
  if (!d) return []
  return [
    ['Debt / equity', ratio(d.debt_to_equity)],
    [
      'Net debt / EBITDA',
      // Net cash is the healthiest state and reads as a negative ratio, which
      // is easy to misread as a data error rather than a strength.
      Number.isFinite(d.net_debt_to_ebitda) && d.net_debt_to_ebitda < 0
        ? `${ratio(d.net_debt_to_ebitda)} (net cash)`
        : ratio(d.net_debt_to_ebitda),
    ],
    ['Interest coverage', ratio(d.interest_coverage)],
    ['Current ratio', ratio(d.current_ratio)],
  ]
})

const research = computed(() =>
  researchUrl({ symbol: props.symbol, name: props.name, sector: props.sector }),
)
</script>

<template>
  <div class="detail">
    <nav class="tabs">
      <button :class="{ on: tab === 'overview' }" @click="tab = 'overview'">Overview</button>
      <button :class="{ on: tab === 'notes' }" @click="tab = 'notes'">
        Notes
        <span v-if="marks.notes || marks.reminders" class="tab-badge">
          {{ marks.notes + marks.reminders }}
        </span>
      </button>
      <span class="spacer" />
      <ListsButton :symbol="symbol" compact />
    </nav>

    <template v-if="tab === 'overview'">
    <!-- Price first: the chart is the thing you opened the row to see. -->
    <section class="chart-block">
      <div class="row chart-head">
        <div class="row ranges">
          <button
            v-for="r in RANGES"
            :key="r"
            class="chip"
            :class="{ on: range === r }"
            @click="range = r"
          >
            {{ r }}
          </button>
        </div>
        <span v-if="chartChange !== null" class="num" :class="chartChange >= 0 ? 'pos' : 'neg'">
          {{ signedPercent(chartChange) }} over {{ range }}
        </span>
        <a
          :href="liveQuoteUrl(symbol)"
          target="_blank"
          rel="noopener noreferrer"
          class="small live"
          title="Live quote and intraday chart on TMX Money — these candles are delayed"
          @click.stop
        >Live ↗</a>
      </div>

      <p v-if="loadingChart" class="muted small">Loading prices…</p>
      <p v-else-if="!symbolId" class="muted small">No Questrade listing, so no price history.</p>
      <template v-else-if="!candles.length">
        <p class="muted small">
          No trades in this window.
          <template v-if="range === '1d'">
            The market may not have opened yet — try 5d.
          </template>
        </p>
      </template>
      <PriceChart v-else :candles="candles" :currency-code="currencyCode" :height="220" />
    </section>

    <div class="columns">
      <section>
        <h4>Market</h4>
        <dl v-if="market.length">
          <div v-for="[label, value] in market" :key="label">
            <dt>{{ label }}</dt>
            <dd class="num">{{ value }}</dd>
          </div>
        </dl>
        <p v-else class="muted small">Loading…</p>
      </section>

      <section v-if="valuationRows.length">
        <h4>
          Valuation
          <span class="grade-inline" :class="`g${valuation.grade}`">{{ valuation.grade }}</span>
        </h4>
        <p class="muted small vnote">
          Cheaper than {{ Math.round(100 - valuation.score) }}% of
          {{ humanSector(valuation.sector || sector) }}, across {{ valuation.peers }} peers
          <template v-if="valuation.factors < 2"> — one factor only, a thin read</template>
        </p>
        <dl>
          <div v-for="[label, value] in valuationRows" :key="label">
            <dt>{{ label }}</dt>
            <dd class="num">{{ value }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="debt">
        <h4>
          Debt load
          <span v-if="debt.grade" class="grade-inline" :class="`g${debt.grade}`">{{ debt.grade }}</span>
          <span v-else class="grade-inline">n/a</span>
        </h4>
        <p v-if="debt.excluded" class="muted small vnote">
          Not graded — bank and insurer leverage is not comparable on these metrics. Deposits are
          not tagged as debt, and there is no EBITDA or meaningful current ratio.
        </p>
        <template v-else>
          <p class="muted small vnote">
            Less indebted than {{ Math.round(100 - debt.score) }}% of
            {{ humanSector(debt.sector || sector) }}, across {{ debt.peers }} peers
            <template v-if="debt.factors < 2"> — one factor only, a thin read</template>
          </p>
          <p v-if="debt.warning" class="small warn">⚠ {{ debt.warning }}</p>
        </template>
        <dl>
          <div v-for="[label, value] in debtRows" :key="label">
            <dt>{{ label }}</dt>
            <dd class="num">{{ value }}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h4>Fundamentals</h4>
        <p v-if="loadingFacts" class="muted small">Loading filings…</p>
        <p v-else-if="!filer || !fundamentals" class="muted small">
          No SEC filings for this company — prices and market data only.
        </p>
        <dl v-else>
          <div v-for="[label, value] in metrics" :key="label">
            <dt>{{ label }}</dt>
            <dd class="num">{{ value }}</dd>
          </div>
        </dl>
      </section>
    </div>

    <div class="row actions">
      <RouterLink :to="`/stock/${symbol}`" class="btn">Full page →</RouterLink>
      <a :href="research" target="_blank" rel="noopener noreferrer" class="btn">Research ↗</a>
      <span v-if="error" class="neg small">{{ error.message }}</span>
    </div>
    </template>

    <!-- Mounted on demand: the panel fetches its own notes and reminders. -->
    <NotesPanel
      v-else
      :symbol="symbol"
      :name="name"
      :price="snapshot?.prevDayClosePrice ?? null"
      :market-cap="snapshot?.marketCap ?? null"
      :currency-code="currencyCode"
    />
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 16px 18px 18px;
  /* The row can be wider than the viewport in a scrolled table; keep the panel
     anchored to the visible area rather than trailing off to the right. */
  position: sticky;
  left: 0;
  width: min(1100px, calc(100vw - 80px));
}

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.tabs > button {
  background: none;
  border: none;
  padding: 5px 12px;
  font-size: 13px;
  color: var(--text);
  border-radius: 6px;
}
.tabs > button.on {
  color: var(--accent);
  background: var(--accent-bg);
}
.tab-badge {
  margin-left: 5px;
  font-size: 10px;
  font-family: var(--mono);
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent-bg);
  color: var(--accent);
}

.chart-head {
  flex-wrap: wrap;
  gap: 10px;
}
.spacer {
  margin-left: auto;
}
.ranges {
  gap: 4px;
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

.columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}

h4 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text);
  margin: 0 0 8px;
}

dl {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 0 20px;
}
dl > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
dt {
  color: var(--text);
}
dd {
  margin: 0;
}

.actions {
  gap: 8px;
  flex-wrap: wrap;
}
.btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-h);
  white-space: nowrap;
}
.btn:hover {
  text-decoration: none;
  border-color: var(--accent-border);
  color: var(--accent);
}

.small {
  font-size: 13px;
}

@media (max-width: 900px) {
  .columns {
    grid-template-columns: 1fr;
  }
}

.grade-inline {
  display: inline-block;
  margin-left: 0.4em;
  padding: 0 5px;
  border: 1px solid currentcolor;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 0.85em;
}
.grade-inline.gA,
.grade-inline.gB {
  color: var(--pos);
}
.grade-inline.gD,
.grade-inline.gF {
  color: var(--neg);
}
.vnote {
  margin: 0 0 0.5em;
}
/* Pushed to the far end of the chart header, away from the range chips, so it
   reads as leaving the app rather than as another range. */
.live {
  margin-left: auto;
  color: var(--accent);
  white-space: nowrap;
}
.warn {
  margin: 0 0 0.5em;
  color: #d98324;
}
</style>
