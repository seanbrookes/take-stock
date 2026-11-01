<script setup>
import { computed, ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { fetchSectors, fetchDbStats } from '../api/local.js'
import { currency, percent, ratio } from '../analysis/format.js'
import StateBlock from '../components/StateBlock.vue'

const sectors = ref([])
const stats = ref(null)
const loading = ref(true)
const error = ref(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const [s, st] = await Promise.all([fetchSectors(), fetchDbStats()])
    sectors.value = s.sectors
    stats.value = st
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}
onMounted(load)

const humanSector = (s) => (s ? s.replace(/([a-z])([A-Z])/g, '$1 $2') : 'Unclassified')

const totalCap = computed(() => sectors.value.reduce((sum, s) => sum + (s.cap ?? 0), 0) || 1)

const enriched = computed(() =>
  sectors.value.map((s) => ({ ...s, weight: (s.cap ?? 0) / totalCap.value })),
)
</script>

<template>
  <div class="stack">
    <div>
      <h1>Sectors</h1>
      <p class="muted sub" v-if="stats">
        Across {{ stats.priced }} priced listings · click a sector for its companies
      </p>
    </div>

    <StateBlock
      :loading="loading"
      :error="error"
      :empty="!loading && !sectors.length"
      empty-text="No sector data yet — import a TMX export and refresh prices from the Screener."
      label="Loading sectors…"
      @retry="load"
    >
      <div class="grid">
        <RouterLink
          v-for="s in enriched"
          :key="s.sector"
          :to="{ path: '/screener', query: { sector: s.sector, category: 'equity' } }"
          class="card sector"
        >
          <div class="row top">
            <h2>{{ humanSector(s.sector) }}</h2>
            <span class="tag">{{ s.count }}</span>
          </div>

          <div class="bar" :title="`${percent(s.weight)} of tracked market cap`">
            <i :style="{ width: `${(s.weight * 100).toFixed(1)}%` }" />
          </div>

          <dl>
            <div><dt>Market cap</dt><dd class="num">{{ currency(s.cap) }}</dd></div>
            <div><dt>Weight</dt><dd class="num">{{ percent(s.weight) }}</dd></div>
            <div><dt>Avg P/E</dt><dd class="num">{{ ratio(s.avg_pe) }}</dd></div>
            <div>
              <dt>Avg yield</dt>
              <dd class="num">{{ s.avg_yield ? percent(s.avg_yield / 100) : '—' }}</dd>
            </div>
          </dl>
        </RouterLink>
      </div>

      <p class="muted tiny">
        Averages are unweighted means across companies in the sector, so a single outlier P/E moves
        them — treat them as rough context, not a valuation.
      </p>
    </StateBlock>
  </div>
</template>

<style scoped>
.sub {
  font-size: 13px;
  margin-top: 6px;
}

.grid {
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}

.sector {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: inherit;
  transition: border-color 0.15s;
}
.sector:hover {
  text-decoration: none;
  border-color: var(--accent-border);
}

.top {
  justify-content: space-between;
}
h2 {
  font-size: 16px;
}

.bar {
  height: 5px;
  border-radius: 3px;
  background: var(--code-bg);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  opacity: 0.7;
}

dl {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
dl > div {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  padding: 2px 0;
}
dt {
  color: var(--text);
}
dd {
  margin: 0;
}

.tiny {
  font-size: 12px;
  margin-top: 14px;
}
</style>
