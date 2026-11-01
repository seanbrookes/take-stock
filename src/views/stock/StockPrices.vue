<script setup>
import { computed, ref, watch } from 'vue'
import { useCompany } from '../../composables/useCompany.js'
import { fetchCandles } from '../../api/questrade.js'
import { useAsyncData } from '../../composables/useAsyncData.js'
import PriceChart from '../../components/PriceChart.vue'
import StateBlock from '../../components/StateBlock.vue'
import { signedPercent } from '../../analysis/format.js'
import { liveQuoteUrl } from '../../analysis/research-link.js'

const { data } = useCompany()
const range = ref('1y')
const RANGES = ['1d', '5d', '1m', '6m', '1y', '5y', 'max']

const symbolId = computed(() => data.value?.listing?.symbolId ?? null)

const { data: candles, error, loading, refresh } = useAsyncData(async () => {
  if (!symbolId.value) return []
  return fetchCandles(symbolId.value, range.value)
})

watch(range, refresh)

const change = computed(() => {
  const c = candles.value ?? []
  if (c.length < 2) return null
  const first = c[0].close
  const last = c.at(-1).close
  return first ? (last - first) / first : null
})

const currency = computed(() => data.value?.listing?.currency ?? '')
const liveUrl = computed(() => {
  const sym = data.value?.listing?.symbol
  return sym ? liveQuoteUrl(sym) : null
})
</script>

<template>
  <div v-if="!symbolId" class="card muted">
    No Questrade listing for this symbol, so no price history is available.
  </div>

  <div v-else class="stack">
    <div class="row toolbar">
      <div class="row ranges">
        <button
          v-for="r in RANGES"
          :key="r"
          :class="{ primary: range === r }"
          @click="range = r"
        >
          {{ r }}
        </button>
      </div>
      <a
        v-if="liveUrl"
        :href="liveUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="small live"
        title="Live quote and intraday chart on TMX Money — these candles are delayed"
      >Live ↗</a>
      <span v-if="change !== null" class="num" :class="change >= 0 ? 'pos' : 'neg'">
        {{ signedPercent(change) }} over {{ range }}
      </span>
      <span class="muted small">{{ currency }}</span>
    </div>

    <StateBlock :loading="loading" :error="error" label="Loading prices…" @retry="refresh">
      <PriceChart :candles="candles ?? []" :currency-code="currency" />
    </StateBlock>

    <p class="muted small">
      Prices from Questrade. Quotes are delayed unless your account carries a market data
      package. Hover or drag across the chart to read a date and price. Closing prices only,
      not adjusted for splits or dividends.
    </p>
  </div>
</template>

<style scoped>
.toolbar {
  flex-wrap: wrap;
  justify-content: space-between;
}
.ranges button {
  padding: 4px 10px;
  font-size: 13px;
}
.small {
  font-size: 12px;
}
.live {
  margin-left: auto;
  color: var(--accent);
  white-space: nowrap;
}
</style>
