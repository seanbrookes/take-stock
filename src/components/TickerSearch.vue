<script setup>
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { searchListings } from '../api/questrade.js'
import { CATEGORIES } from '../api/classify.js'
import {
  selectedCategories,
  toggleCategory,
  setAllCategories,
  isAllSelected,
} from '../stores/searchFilters.js'

const router = useRouter()
const query = ref('')
const results = ref([])
const open = ref(false)
const active = ref(0)
const source = ref('')
const degraded = ref(null)

const filteredOut = ref(0)
const showFilters = ref(false)

/** All search strategy lives in the api layer — see searchListings(). */
async function runSearch(q) {
  const result = await searchListings(q, { categories: [...selectedCategories] })
  source.value = result.source
  degraded.value = result.degraded
  filteredOut.value = result.filtered ?? 0
  return result.rows
}

/** Re-run the current query when the filter changes, so it feels live. */
watch(selectedCategories, async () => {
  if (!query.value.trim()) return
  results.value = await runSearch(query.value.trim())
  active.value = 0
  open.value = true
}, { deep: true })

const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label ?? id

let debounce
watch(query, (q) => {
  clearTimeout(debounce)
  if (!q.trim()) {
    results.value = []
    open.value = false
    return
  }
  debounce = setTimeout(async () => {
    results.value = await runSearch(q.trim())
    active.value = 0
    open.value = true
  }, 180)
})

function go(row) {
  if (!row) return
  query.value = ''
  results.value = []
  open.value = false
  router.push(`/stock/${encodeURIComponent(row.ticker)}`)
}

function onEnter() {
  if (results.value.length) return go(results.value[active.value])
  const raw = query.value.trim().toUpperCase()
  if (raw) go({ ticker: raw })
}

function move(delta) {
  if (!results.value.length) return
  active.value = (active.value + delta + results.value.length) % results.value.length
}

// Closing on blur immediately would cancel the click that selects a result.
function onBlur() {
  setTimeout(() => (open.value = false), 150)
}
</script>

<template>
  <div class="search" @keydown.escape="open = false">
    <input
      v-model="query"
      type="search"
      placeholder="Search ticker or company (try SHOP.TO)…"
      autocomplete="off"
      spellcheck="false"
      @focus="open = results.length > 0"
      @blur="onBlur"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="onEnter"
    />

    <button
      class="filter-toggle"
      :class="{ on: showFilters }"
      :title="`Filter by type — showing ${selectedCategories.length} of ${CATEGORIES.length}`"
      @click="showFilters = !showFilters"
    >
      ⚙ {{ isAllSelected() ? 'All types' : `${selectedCategories.length} types` }}
    </button>

    <div v-if="showFilters" class="filters">
      <div class="filter-head">
        <strong>Show</strong>
        <button class="link" @click="setAllCategories(!isAllSelected())">
          {{ isAllSelected() ? 'Clear all' : 'Select all' }}
        </button>
      </div>
      <label v-for="c in CATEGORIES" :key="c.id" class="filter-row">
        <input
          type="checkbox"
          :checked="selectedCategories.includes(c.id)"
          @change="toggleCategory(c.id)"
        />
        <span>{{ c.label }}</span>
        <span class="muted hint">{{ c.hint }}</span>
      </label>
    </div>

    <ul v-if="open && (results.length || degraded)" class="results">
      <li v-if="degraded" class="degraded">⚠ {{ degraded }}</li>
      <li
        v-for="(row, i) in results"
        :key="row.ticker + row.exchange"
        :class="{ active: i === active }"
        @mousedown.prevent="go(row)"
        @mouseenter="active = i"
      >
        <span class="tag">{{ row.ticker }}</span>
        <span class="name">{{ row.name }}</span>
        <span class="muted ex">{{ categoryLabel(row.category) }} · {{ row.exchange }}</span>
      </li>
      <li v-if="results.length || filteredOut" class="source muted">
        via {{ source }}
        <template v-if="filteredOut">
          · {{ filteredOut }} hidden by type filter
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search {
  position: relative;
  flex: 1 1 auto;
  max-width: 460px;
}

input {
  width: 100%;
}

.results {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
  max-height: 360px;
  overflow-y: auto;
}

li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 5px;
  cursor: pointer;
}
li.active {
  background: var(--accent-bg);
}

.name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ex {
  margin-left: auto;
  font-size: 11px;
  flex-shrink: 0;
}

.filter-toggle {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  padding: 3px 8px;
  font-size: 11px;
  background: var(--bg-soft);
  color: var(--text);
}
.filter-toggle.on {
  color: var(--accent);
  border-color: var(--accent-border);
}

.filters {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 30;
  min-width: 260px;
  padding: 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.filter-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.filter-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 2px;
  font-size: 13px;
  cursor: pointer;
}
.filter-row input {
  width: auto;
  padding: 0;
  accent-color: var(--accent);
}
.filter-row .hint {
  margin-left: auto;
  font-size: 11px;
}

.link {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--accent);
}

.degraded {
  cursor: default;
  font-size: 12px;
  line-height: 145%;
  color: var(--neg);
  white-space: normal;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  margin-bottom: 4px;
}
.degraded:hover {
  background: none;
}

.source {
  cursor: default;
  font-size: 11px;
  justify-content: center;
  border-top: 1px solid var(--border);
  border-radius: 0;
  margin-top: 4px;
}
.source:hover {
  background: none;
}
</style>
