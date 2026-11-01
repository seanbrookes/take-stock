<script setup>
import { computed, ref } from 'vue'
import { useCompany } from '../../composables/useCompany.js'
import { BASE_METRICS } from '../../analysis/metrics.js'
import { formatBy, periodLabel } from '../../analysis/format.js'

const { fundamentals, period } = useCompany()

const STATEMENTS = [
  { key: 'income', title: 'Income statement' },
  { key: 'balance', title: 'Balance sheet' },
  { key: 'cashflow', title: 'Cash flow' },
]

const columnCount = ref(8)

/** Newest-first period columns, capped so the table stays readable. */
const columns = computed(() => (fundamentals.value?.periods ?? []).slice(0, columnCount.value))

/**
 * Index each series by period end date once, rather than scanning the points
 * array for every cell — this table is metrics x periods and gets big.
 */
const lookup = computed(() => {
  const map = {}
  for (const [id, series] of Object.entries(fundamentals.value?.series ?? {})) {
    if (!series) continue
    const byEnd = new Map()
    for (const p of series.points) byEnd.set(p.end, p.val)
    map[id] = byEnd
  }
  return map
})

const rowsFor = (statement) =>
  BASE_METRICS.filter((m) => m.statement === statement && lookup.value[m.id])

const cell = (id, end) => lookup.value[id]?.get(end)

const tagFor = (id) => fundamentals.value?.series?.[id]?.tag ?? ''
</script>

<template>
  <div class="stack">
    <div class="row toolbar">
      <label class="muted">
        Show
        <select v-model.number="columnCount">
          <option :value="5">5</option>
          <option :value="8">8</option>
          <option :value="12">12</option>
          <option :value="20">20</option>
        </select>
        {{ period === 'annual' ? 'years' : 'quarters' }}
      </label>
      <span class="muted small">
        Values are restatement-aware: where a period was re-reported, the most recently filed
        figure is used.
      </span>
    </div>

    <section v-for="s in STATEMENTS" :key="s.key">
      <h2>{{ s.title }}</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th class="sticky-col">Metric</th>
              <th v-for="end in columns" :key="end" class="num">{{ periodLabel(end) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in rowsFor(s.key)" :key="m.id">
              <td class="sticky-col">
                {{ m.label }}
                <span class="tag xbrl" :title="`XBRL tag: ${tagFor(m.id)}`">{{ tagFor(m.id) }}</span>
              </td>
              <td v-for="end in columns" :key="end" class="num">
                {{ formatBy(m.format, cell(m.id, end)) }}
              </td>
            </tr>
            <tr v-if="!rowsFor(s.key).length">
              <td :colspan="columns.length + 1" class="muted">
                No {{ s.title.toLowerCase() }} tags found for this filer.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <p v-if="fundamentals?.missing?.length" class="muted small">
      Not reported by this company:
      {{ fundamentals.missing.join(', ') }}
    </p>
  </div>
</template>

<style scoped>
.toolbar {
  flex-wrap: wrap;
  justify-content: space-between;
}

.small {
  font-size: 12px;
}

h2 {
  margin-bottom: 12px;
}

.sticky-col {
  position: sticky;
  left: 0;
  background: var(--bg);
  z-index: 1; /* above body cells, below the sticky header (2) */
}
thead .sticky-col {
  background: var(--bg-soft);
  z-index: 3; /* the corner cell overlaps both sticky axes */
}
tbody tr:hover .sticky-col {
  background: var(--bg-soft);
}

.xbrl {
  margin-left: 8px;
  font-size: 10px;
  opacity: 0.6;
}

select {
  padding: 3px 6px;
  margin: 0 4px;
}
</style>
