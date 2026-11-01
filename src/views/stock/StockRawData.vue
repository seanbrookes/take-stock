<script setup>
import { computed, ref } from 'vue'
import { useCompany } from '../../composables/useCompany.js'
import { listAllTags } from '../../api/facts.js'
import { periodLabel } from '../../analysis/format.js'

/**
 * Every XBRL fact the company has ever filed, searchable — nothing the curated
 * metric catalog leaves out is hidden from you here.
 */
const { data } = useCompany()

const query = ref('')
const expanded = ref(null)

const allTags = computed(() => (data.value ? listAllTags(data.value.facts) : []))

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return allTags.value
  return allTags.value.filter(
    (t) =>
      t.tag.toLowerCase().includes(q) ||
      t.label.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q),
  )
})

const key = (t) => `${t.taxonomy}:${t.tag}:${t.unit}`

function toggle(t) {
  expanded.value = expanded.value === key(t) ? null : key(t)
}

/** Full datapoint history for the expanded tag, newest first. */
const pointsFor = (t) => {
  const node = data.value?.facts?.facts?.[t.taxonomy]?.[t.tag]
  return [...(node?.units?.[t.unit] ?? [])].sort((a, b) => b.end.localeCompare(a.end))
}

const num = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '—')

function downloadJson() {
  // Blob download rather than a data: URI — companyfacts payloads exceed
  // what a URL can carry.
  const blob = new Blob([JSON.stringify(data.value.facts, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${data.value.filer?.ticker ?? 'company'}-companyfacts.json`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="stack">
    <div class="row toolbar">
      <input v-model="query" type="search" placeholder="Filter tags, labels, descriptions…" />
      <span class="muted small">{{ filtered.length }} of {{ allTags.length }} series</span>
      <button @click="downloadJson">Download JSON</button>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Tag</th>
            <th>Label</th>
            <th>Unit</th>
            <th class="num">Points</th>
            <th class="num">Latest</th>
            <th>As of</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="t in filtered" :key="key(t)">
            <tr class="clickable" @click="toggle(t)">
              <td><code>{{ t.tag }}</code></td>
              <td class="label" :title="t.description">{{ t.label }}</td>
              <td class="muted">{{ t.unit }}</td>
              <td class="num">{{ t.count }}</td>
              <td class="num">{{ num(t.latest?.val) }}</td>
              <td>{{ periodLabel(t.latest?.end) }}</td>
            </tr>

            <tr v-if="expanded === key(t)" class="detail">
              <td colspan="6">
                <p v-if="t.description" class="muted desc">{{ t.description }}</p>
                <div class="table-scroll inner">
                  <table>
                    <thead>
                      <tr>
                        <th>Start</th>
                        <th>End</th>
                        <th class="num">Value</th>
                        <th>FY</th>
                        <th>Form</th>
                        <th>Filed</th>
                        <th>Accession</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(p, i) in pointsFor(t)" :key="p.accn + p.end + i">
                        <td>{{ p.start ?? '—' }}</td>
                        <td>{{ p.end }}</td>
                        <td class="num">{{ num(p.val) }}</td>
                        <td>{{ p.fy }} {{ p.fp }}</td>
                        <td><span class="tag">{{ p.form }}</span></td>
                        <td>{{ p.filed }}</td>
                        <td class="muted"><code>{{ p.accn }}</code></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </td>
            </tr>
          </template>

          <tr v-if="!filtered.length">
            <td colspan="6" class="muted">No tags match “{{ query }}”.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  flex-wrap: wrap;
}
.toolbar input {
  flex: 1 1 260px;
}

.small {
  font-size: 12px;
}

.clickable {
  cursor: pointer;
}

.label {
  white-space: normal;
  max-width: 380px;
}

.detail > td {
  background: var(--bg-soft);
  white-space: normal;
  padding: 12px;
}

.desc {
  font-size: 12px;
  margin-bottom: 10px;
  max-width: 70ch;
}

/* Two class names so this reliably beats the global .table-scroll cap rather
   than depending on stylesheet order. */
.table-scroll.inner {
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg);
}
</style>
