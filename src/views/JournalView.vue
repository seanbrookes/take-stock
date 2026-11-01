<script setup>
import { computed, ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import {
  fetchAllNotes,
  fetchReminders,
  completeReminder,
  removeReminder,
  fetchGroups,
  removeGroup,
  createGroup,
  NOTE_KINDS,
} from '../api/journal.js'
import { perShare, currency } from '../analysis/format.js'
import StateBlock from '../components/StateBlock.vue'

const notes = ref([])
const reminders = ref([])
const groups = ref([])
const query = ref('')
const loading = ref(true)
const error = ref(null)
const newGroup = ref('')

async function load() {
  loading.value = true
  try {
    const [n, r, g] = await Promise.all([fetchAllNotes(query.value), fetchReminders(), fetchGroups()])
    notes.value = n.notes
    reminders.value = r.reminders
    groups.value = g.groups
    error.value = null
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}
onMounted(load)

let debounce
const search = () => {
  clearTimeout(debounce)
  debounce = setTimeout(load, 200)
}

async function finish(r) {
  await completeReminder(r.id)
  await load()
}
async function drop(r) {
  await removeReminder(r.id)
  await load()
}
async function dropGroup(g) {
  if (!confirm(`Delete the list "${g.name}"? The notes on those companies are kept.`)) return
  await removeGroup(g.id)
  await load()
}
async function addGroup() {
  const name = newGroup.value.trim()
  if (!name) return
  await createGroup({ name }).catch(() => {})
  newGroup.value = ''
  await load()
}

const overdue = computed(() => reminders.value.filter((r) => Date.parse(r.due_at) <= Date.now()))
const upcoming = computed(() => reminders.value.filter((r) => Date.parse(r.due_at) > Date.now()))

const kindLabel = (id) => NOTE_KINDS.find((k) => k.id === id)?.label ?? 'Note'
const when = (iso) => new Date(iso).toLocaleDateString('en-CA', { dateStyle: 'medium' })

/** Notes grouped by symbol so a company's thinking reads together. */
const bySymbol = computed(() => {
  const map = new Map()
  for (const n of notes.value) {
    if (!map.has(n.symbol)) map.set(n.symbol, [])
    map.get(n.symbol).push(n)
  }
  return [...map]
})

function segments(text) {
  const out = []
  let last = 0
  for (const m of text.matchAll(/(https?:\/\/[^\s<>"']+)/g)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ text: m[0], href: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
</script>

<template>
  <div class="stack">
    <div class="head">
      <div>
        <h1>Journal</h1>
        <p class="muted sub">Your notes, reminders and custom lists</p>
      </div>
      <input v-model="query" type="search" placeholder="Search notes…" @input="search" />
    </div>

    <StateBlock :loading="loading" :error="error" label="Loading journal…" @retry="load">
      <div class="stack">
        <section v-if="overdue.length" class="card due-card">
          <h2>Due now ({{ overdue.length }})</h2>
          <ul class="reminders">
            <li v-for="r in overdue" :key="r.id">
              <RouterLink :to="`/stock/${r.symbol}`" class="tag">{{ r.symbol }}</RouterLink>
              <span class="muted date">{{ when(r.due_at) }}</span>
              <span class="body">{{ r.body || 'Check in' }}</span>
              <button class="link" @click="finish(r)">Done</button>
              <button class="link muted" @click="drop(r)">Delete</button>
            </li>
          </ul>
        </section>

        <section v-if="upcoming.length" class="card">
          <h2>Upcoming</h2>
          <ul class="reminders">
            <li v-for="r in upcoming" :key="r.id">
              <RouterLink :to="`/stock/${r.symbol}`" class="tag">{{ r.symbol }}</RouterLink>
              <span class="muted date">{{ when(r.due_at) }}</span>
              <span class="body">{{ r.body || 'Check in' }}</span>
              <button class="link" @click="finish(r)">Done</button>
              <button class="link muted" @click="drop(r)">Delete</button>
            </li>
          </ul>
        </section>

        <section class="card">
          <h2>Lists</h2>
          <div class="groups">
            <RouterLink
              v-for="g in groups"
              :key="g.id"
              :to="{ path: '/screener', query: { group: g.id } }"
              class="group"
            >
              {{ g.name }} <span class="muted">{{ g.members }}</span>
            </RouterLink>
            <span v-if="!groups.length" class="muted tiny">
              None yet — create one from any company's Notes tab.
            </span>
          </div>
          <div class="row new-group">
            <input v-model="newGroup" placeholder="New list…" @keydown.enter.prevent="addGroup" />
            <button :disabled="!newGroup.trim()" @click="addGroup">Create</button>
            <button
              v-for="g in groups"
              :key="'del' + g.id"
              class="link muted tiny"
              @click="dropGroup(g)"
            >
              delete {{ g.name }}
            </button>
          </div>
        </section>

        <section v-if="bySymbol.length">
          <h2>{{ notes.length }} note{{ notes.length === 1 ? '' : 's' }}</h2>
          <div v-for="[symbol, items] in bySymbol" :key="symbol" class="company">
            <h3>
              <RouterLink :to="`/stock/${symbol}`">{{ symbol }}</RouterLink>
              <span class="muted count">{{ items.length }}</span>
            </h3>
            <article v-for="n in items" :key="n.id">
              <header>
                <span class="tag">{{ kindLabel(n.kind) }}</span>
                <span class="muted">{{ when(n.created_at) }}</span>
                <span v-if="n.price_at" class="muted">
                  at {{ perShare(n.price_at) }}<template v-if="n.cap_at">
                    · {{ currency(n.cap_at) }}</template>
                </span>
                <span v-if="n.pinned" class="pin">★</span>
              </header>
              <p class="body">
                <template v-for="(seg, i) in segments(n.body)" :key="i">
                  <a v-if="seg.href" :href="seg.href" target="_blank" rel="noopener noreferrer">{{ seg.text }}</a>
                  <template v-else>{{ seg.text }}</template>
                </template>
              </p>
            </article>
          </div>
        </section>

        <p v-else class="muted">
          {{ query ? `No notes match “${query}”.` : 'No notes yet — add one from any company page.' }}
        </p>
      </div>
    </StateBlock>
  </div>
</template>

<style scoped>
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
.head input {
  min-width: 220px;
}

h2 {
  font-size: 15px;
  margin-bottom: 10px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.due-card {
  border-color: var(--accent-border);
  background: var(--accent-bg);
}

.reminders {
  list-style: none;
  margin: 0;
  padding: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.reminders li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.reminders .body {
  flex: 1;
}
.date {
  font-family: var(--mono);
  font-size: 11px;
}

.groups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.group {
  padding: 4px 11px;
  border: 1px solid var(--border);
  border-radius: 20px;
  font-size: 13px;
  color: var(--text-h);
}
.group:hover {
  text-decoration: none;
  border-color: var(--accent-border);
}
.new-group {
  flex-wrap: wrap;
}
.new-group input {
  padding: 4px 10px;
  font-size: 13px;
}

.company {
  margin-bottom: 20px;
}
.company h3 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
  margin-bottom: 8px;
}
.count {
  font-size: 12px;
}

article {
  border-left: 2px solid var(--border);
  padding: 4px 0 8px 12px;
  margin-bottom: 6px;
}
article header {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 12px;
  margin-bottom: 4px;
}
.pin {
  color: var(--accent);
}
.body {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 155%;
}

.link {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--accent);
}
.link.muted {
  color: var(--text);
}
.tiny {
  font-size: 12px;
}
</style>
