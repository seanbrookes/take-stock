<script setup>
import { computed } from 'vue'
import { useCompany } from '../../composables/useCompany.js'
import {
  formatBy,
  currency,
  perShare,
  percent,
  ratio,
  shares,
  signedPercent,
  periodLabel,
  trendClass,
} from '../../analysis/format.js'
import SparkLine from '../../components/SparkLine.vue'

const { data, fundamentals, ttm, period, hasFundamentals } = useCompany()

const quote = computed(() => data.value?.quote ?? null)
const listing = computed(() => data.value?.listing ?? null)

/** Market snapshot from Questrade — available even with no SEC filings. */
const snapshot = computed(() => {
  const q = quote.value
  if (!q) return []
  return [
    { label: 'Market cap', value: currency(q.marketCap) },
    { label: 'P/E', value: ratio(q.pe) },
    { label: 'EPS', value: perShare(q.eps) },
    { label: 'Dividend yield', value: q.yield ? percent(q.yield / 100) : '—' },
    { label: '52-week range', value: `${perShare(q.lowPrice52)} – ${perShare(q.highPrice52)}` },
    { label: 'Shares outstanding', value: shares(q.outstandingShares) },
  ]
})

/**
 * The reporting currency of the filings, which is not always the currency the
 * shares trade in. Mixing a CAD market cap with USD financials would produce a
 * confidently wrong valuation ratio, so cross-source metrics are gated on this.
 */
const filingCurrency = computed(() => {
  const unit = fundamentals.value?.series?.revenue?.unit
  return unit ? unit.replace('/shares', '') : null
})

const currenciesAgree = computed(
  () => Boolean(listing.value?.currency && filingCurrency.value === listing.value.currency),
)

/**
 * Valuation needs a price (Questrade) and fundamentals (SEC) together — the
 * one thing neither source can do alone.
 */
const valuation = computed(() => {
  if (!currenciesAgree.value || !quote.value?.marketCap) return []
  const cap = quote.value.marketCap
  const t = ttm.value
  const fcf = t?.operatingCashFlow && t?.capex ? t.operatingCashFlow.val - t.capex.val : null
  const rev = t?.revenue?.val ?? fundamentals.value?.values?.revenue
  const netDebt = fundamentals.value?.derived?.find((d) => d.id === 'netDebt')?.value

  return [
    { label: 'FCF yield', value: fcf ? percent(fcf / cap) : '—', note: 'Trailing free cash flow ÷ market cap' },
    { label: 'Price / sales', value: rev ? ratio(cap / rev) : '—' },
    {
      label: 'Enterprise value',
      value: Number.isFinite(netDebt) ? currency(cap + netDebt) : '—',
      note: 'Market cap plus net debt',
    },
  ]
})

const groups = computed(() => {
  const out = new Map()
  for (const m of fundamentals.value?.derived ?? []) {
    if (!out.has(m.group)) out.set(m.group, [])
    out.get(m.group).push(m)
  }
  return [...out]
})

const asOf = computed(() => fundamentals.value?.periods?.[0] ?? null)

const headline = computed(() => {
  const t = ttm.value
  if (!t) return []
  const fcf = t.operatingCashFlow && t.capex ? t.operatingCashFlow.val - t.capex.val : null
  return [
    { label: 'Revenue (TTM)', value: currency(t.revenue?.val) },
    { label: 'Net income (TTM)', value: currency(t.netIncome?.val) },
    { label: 'Free cash flow (TTM)', value: currency(fcf) },
    { label: 'EPS (TTM)', value: perShare(t.epsDiluted?.val) },
  ]
})

const trend = (id) =>
  (fundamentals.value?.series?.[id]?.points ?? []).slice(-8).map((p) => p.val)

const recentFilings = computed(() => {
  const recent = data.value?.submissions?.filings?.recent
  if (!recent) return []
  const wanted = new Set(['10-K', '10-Q', '40-F', '20-F', '6-K', '8-K'])
  const rows = []
  for (let i = 0; i < recent.form.length && rows.length < 8; i++) {
    if (!wanted.has(recent.form[i])) continue
    rows.push({
      form: recent.form[i],
      filed: recent.filingDate[i],
      accn: recent.accessionNumber[i],
      doc: recent.primaryDocument[i],
    })
  }
  return rows
})

const filingUrl = (row) => {
  const cik = String(data.value?.submissions?.cik ?? '').replace(/^0+/, '')
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${row.accn.replace(/-/g, '')}/${row.doc}`
}
</script>

<template>
  <div class="stack">
    <section v-if="snapshot.length">
      <h2>Market</h2>
      <div class="grid">
        <div v-for="s in snapshot" :key="s.label" class="card kpi">
          <span class="muted label">{{ s.label }}</span>
          <span class="num big">{{ s.value }}</span>
        </div>
      </div>
      <p class="muted note">
        From Questrade, in {{ listing?.currency ?? 'listing currency' }}. Delayed unless your
        account has a market data package.
      </p>
    </section>

    <section v-if="valuation.length">
      <h2>Valuation</h2>
      <div class="grid">
        <div v-for="v in valuation" :key="v.label" class="card kpi">
          <span class="muted label">{{ v.label }}</span>
          <span class="num big">{{ v.value }}</span>
          <span v-if="v.note" class="muted hint">{{ v.note }}</span>
        </div>
      </div>
    </section>

    <p v-else-if="hasFundamentals && quote && !currenciesAgree" class="muted note warn">
      Valuation ratios are hidden: this company trades in
      {{ listing?.currency }} but reports in {{ filingCurrency }}, and combining the two would
      produce a wrong number.
    </p>

    <template v-if="hasFundamentals">
      <section>
        <h2>Results</h2>
        <div class="grid">
          <div v-for="h in headline" :key="h.label" class="card kpi">
            <span class="muted label">{{ h.label }}</span>
            <span class="num big">{{ h.value }}</span>
          </div>
        </div>
        <p class="muted note">
          Trailing twelve months, summed from the last four quarters. Filings reported in
          {{ filingCurrency ?? 'their reporting currency' }}.
        </p>
      </section>

      <section v-for="[group, metrics] in groups" :key="group">
        <h2>{{ group }}</h2>
        <div class="grid">
          <div v-for="m in metrics" :key="m.id" class="card kpi">
            <span class="muted label">{{ m.label }}</span>
            <span class="num big">{{ formatBy(m.format, m.value) }}</span>
            <span v-if="m.note" class="muted hint">{{ m.note }}</span>
          </div>
        </div>
      </section>

      <section>
        <h2>Growth</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                <th class="num">Latest change</th>
                <th class="num">3-period CAGR</th>
                <th class="num">5-period CAGR</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in fundamentals?.growth ?? []" :key="g.id">
                <td>{{ g.label }}</td>
                <td class="num" :class="trendClass(g.yoy, g.invertGood)">{{ signedPercent(g.yoy) }}</td>
                <td class="num" :class="trendClass(g.cagr3, g.invertGood)">{{ signedPercent(g.cagr3) }}</td>
                <td class="num" :class="trendClass(g.cagr5, g.invertGood)">{{ signedPercent(g.cagr5) }}</td>
                <td :class="trendClass(g.cagr3, g.invertGood)">
                  <SparkLine :values="trend(g.id)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="muted note">
          Periods are {{ period === 'annual' ? 'fiscal years' : 'quarters' }}; latest data as of
          {{ periodLabel(asOf) }}.
        </p>
      </section>

      <section v-if="recentFilings.length">
        <h2>Recent filings</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr><th>Form</th><th>Filed</th><th>Document</th></tr>
            </thead>
            <tbody>
              <tr v-for="f in recentFilings" :key="f.accn">
                <td><span class="tag">{{ f.form }}</span></td>
                <td>{{ f.filed }}</td>
                <td><a :href="filingUrl(f)" target="_blank" rel="noopener">{{ f.accn }}</a></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.kpi {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.label {
  font-size: 12px;
}
.big {
  font-size: 21px;
  text-align: left;
}
.hint {
  font-size: 11px;
  line-height: 135%;
  margin-top: 2px;
}
.note {
  font-size: 12px;
  margin-top: 10px;
}
.warn {
  border-left: 2px solid var(--accent);
  padding-left: 10px;
}
h2 {
  margin-bottom: 12px;
}
</style>
