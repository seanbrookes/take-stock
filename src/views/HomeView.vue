<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { state, loadLists, membersOf, deleteList, createList, DEFAULT_LIST } from '../stores/lists.js'
import { fetchSymbolsByNames, fetchQuotes } from '../api/questrade.js'
import { useHistory } from '../composables/useHistory.js'
import { currency, percent, ratio, perShare, signedPercent, trendClass } from '../analysis/format.js'
import { researchUrl } from '../analysis/research-link.js'
import SparkLine from '../components/SparkLine.vue'
import MagnitudeBar from '../components/MagnitudeBar.vue'
import StockRowDetail from '../components/StockRowDetail.vue'
import RowBadges from '../components/RowBadges.vue'
import { loadAnnotations } from '../stores/annotations.js'
import StateBlock from '../components/StateBlock.vue'

const rows = ref([])
const loading = ref(false)
const error = ref(null)
const active = ref(null)
const newName = ref('')

const history = useHistory({ range: '1m', concurrency: 4 })

/** Lists in a stable order, with the default one first. */
const lists = computed(() =>
  [...state.groups].sort((a, b) =>
    a.name === DEFAULT_LIST ? -1 : b.name === DEFAULT_LIST ? 1 : a.name.localeCompare(b.name),
  ),
)

const current = computed(
  () => lists.value.find((g) => String(g.id) === String(active.value)) ?? lists.value[0] ?? null,
)

async function loadRows() {
  const group = current.value
  if (!group) {
    rows.value = []
    return
  }
  const symbols = membersOf(group.id)
  if (!symbols.length) {
    rows.value = []
    return
  }

  loading.value = true
  error.value = null
  try {
    const detail = await fetchSymbolsByNames(symbols)
    const quotes = await fetchQuotes(detail.map((s) => s.symbolId))
    const byId = new Map(quotes.map((q) => [q.symbolId, q]))

    rows.value = detail.map((s) => {
      const q = byId.get(s.symbolId) ?? {}
      const last = q.lastTradePrice ?? s.prevDayClosePrice
      const range = s.highPrice52 - s.lowPrice52
      return {
        symbol: s.symbol,
        symbolId: s.symbolId,
        name: s.description,
        sector: s.industrySector ?? '',
        currency: s.currency,
        last,
        prevClose: s.prevDayClosePrice,
        dayChange:
          s.prevDayClosePrice && last ? (last - s.prevDayClosePrice) / s.prevDayClosePrice : null,
        marketCap: s.marketCap,
        pe: s.pe || null,
        yield: s.yield ? s.yield / 100 : null,
        high52: s.highPrice52,
        low52: s.lowPrice52,
        rangePos: range > 0 && last ? (last - s.lowPrice52) / range : null,
        spark: null,
        sparkChange: null,
      }
    })
    history.sweep(rows.value)
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  loadAnnotations()
  if (!state.loaded) await loadLists()
  await loadRows()
})
watch(current, loadRows)
watch(() => state.bySymbol, loadRows, { deep: true })

async function addList() {
  const name = newName.value.trim()
  if (!name) return
  const group = await createList(name)
  newName.value = ''
  active.value = group.id
}

async function dropList(group) {
  if (!confirm(`Delete the list "${group.name}"? Notes on those companies are kept.`)) return
  await deleteList(group.id)
  active.value = null
  await loadRows()
}

const expanded = ref(null)
const toggle = (symbol) => (expanded.value = expanded.value === symbol ? null : symbol)

const empty = computed(() => !loading.value && !rows.value.length)
</script>

<template>
  <div class="stack">
    <div class="head">
      <div>
        <h1>{{ current?.name ?? 'Watchlist' }}</h1>
        <p class="muted sub">{{ rows.length }} companies · live from Questrade</p>
      </div>
      <button :disabled="history.loading.value || !rows.length" @click="history.sweep(rows, { force: true })">
        {{ history.loading.value ? `History ${history.done.value}/${history.total.value}…` : 'Reload history' }}
      </button>
    </div>

    <div class="row lists">
      <button
        v-for="g in lists"
        :key="g.id"
        class="chip"
        :class="{ on: current && String(current.id) === String(g.id) }"
        @click="active = g.id"
      >
        {{ g.name }} <span class="chip-n">{{ g.members }}</span>
      </button>
      <input v-model="newName" placeholder="New list…" @keydown.enter.prevent="addList" />
      <button :disabled="!newName.trim()" @click="addList">Create</button>
      <button v-if="current" class="link muted" @click="dropList(current)">
        delete “{{ current.name }}”
      </button>
    </div>

    <StateBlock
      :loading="loading"
      :error="error"
      :empty="empty"
      :empty-text="
        lists.length
          ? `Nothing in “${current?.name}” yet — open any company and use ☆ Watch or the Lists menu.`
          : 'No lists yet. Open any company and press ☆ Watch, or create a list above.'
      "
      label="Loading watchlist…"
      @retry="loadRows"
    >
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Company</th>
              <th class="num">Last</th>
              <th class="num">Day</th>
              <th class="num">30 days</th>
              <th class="num">Market cap</th>
              <th class="num">P/E</th>
              <th class="num">Yield</th>
              <th class="num">52w pos</th>
              <th class="actions-cell"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in rows" :key="r.symbol">
            <tr :class="{ open: expanded === r.symbol }">
              <td>
                <RouterLink :to="`/stock/${r.symbol}`" class="tag">
                  {{ r.symbol.replace(/\.(TO|VN)$/, '') }}
                </RouterLink>
                <RowBadges :symbol="r.symbol" />
              </td>
              <td class="cname">{{ r.name }}</td>
              <td class="num">{{ perShare(r.last) }}</td>
              <td class="num" :class="trendClass(r.dayChange)">{{ signedPercent(r.dayChange) }}</td>
              <td class="num spark" :class="trendClass(r.sparkChange)">
                <SparkLine v-if="r.spark" :values="r.spark" :width="64" :height="18" />
                <span v-if="r.sparkChange != null" class="s30">{{ signedPercent(r.sparkChange) }}</span>
              </td>
              <td class="num cap-cell">
                <span>{{ currency(r.marketCap) }}</span>
                <MagnitudeBar :value="r.marketCap" />
              </td>
              <td class="num">{{ ratio(r.pe) }}</td>
              <td class="num">{{ percent(r.yield) }}</td>
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
                  :href="researchUrl({ symbol: r.symbol, name: r.name, sector: r.sector })"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="small research"
                >Research ↗</a>
                </div>
              </td>
            </tr>

            <tr v-if="expanded === r.symbol" class="detail-row">
              <td colspan="10">
                <StockRowDetail
                  :symbol="r.symbol"
                  :symbol-id="r.symbolId"
                  :name="r.name"
                  :sector="r.sector"
                  :currency-code="r.currency"
                />
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </div>
    </StateBlock>
  </div>
</template>

<style scoped>
/* Height budget for the sticky-header scroll area: window minus the toolbar,
   filters and summary line above it. */
.stack {
  --table-max: calc(100svh - 250px);
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

.lists {
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 4px 11px;
  font-size: 13px;
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
  font-size: 11px;
}
.lists input {
  padding: 4px 10px;
  font-size: 13px;
  width: 130px;
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

.cname {
  white-space: normal;
  max-width: 280px;
  font-size: 13px;
}

.spark {
  min-width: 104px;
  white-space: nowrap;
}
.spark svg {
  vertical-align: middle;
}
.s30 {
  margin-left: 6px;
  font-size: 11px;
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

.actions-cell {
  white-space: nowrap;
}
/* flex belongs inside the cell — see ScreenerView for why. */
.actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  white-space: nowrap;
}
.small {
  font-size: 12px;
}
.research {
  color: var(--text);
}
.research:hover {
  color: var(--accent);
}
.link {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--text);
}
.link:hover {
  text-decoration: underline;
}
</style>
