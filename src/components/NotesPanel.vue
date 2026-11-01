<script setup>
import { computed, ref, watch, onMounted } from 'vue'
import {
  fetchNotes,
  createNote,
  editNote,
  removeNote,
  NOTE_KINDS,
  fetchReminders,
  createReminder,
  completeReminder,
  removeReminder,
  REMINDER_PRESETS,
  dueDateFrom,
} from '../api/journal.js'
import { RouterLink } from 'vue-router'
import { refreshAnnotations } from '../stores/annotations.js'
import { perShare, currency } from '../analysis/format.js'

const props = defineProps({
  symbol: { type: String, required: true },
  name: { type: String, default: '' },
  /** Current price context, stamped onto new notes. */
  price: { type: Number, default: null },
  marketCap: { type: Number, default: null },
  /** Currency CODE, not a formatter — see PriceChart for why the name matters. */
  currencyCode: { type: String, default: '' },
})

const notes = ref([])
const reminders = ref([])
const draft = ref('')
const kind = ref('note')
const busy = ref(false)
const error = ref(null)
const editingId = ref(null)
const editBody = ref('')
const reminderDate = ref('')
const reminderBody = ref('')
const reminderNotice = ref(null)

async function load() {
  try {
    const [n, r] = await Promise.all([fetchNotes(props.symbol), fetchReminders(props.symbol)])
    notes.value = n.notes
    reminders.value = r.reminders
    error.value = null
    // Keeps the row badges in the lists honest without a page reload.
    refreshAnnotations()
  } catch (err) {
    error.value = err
  }
}

onMounted(load)
watch(() => props.symbol, load)

async function submit() {
  const body = draft.value.trim()
  if (!body || busy.value) return
  busy.value = true
  try {
    // Price context is captured now, not looked up later: a thesis only makes
    // sense against the price you formed it at.
    await createNote({
      symbol: props.symbol,
      body,
      kind: kind.value,
      priceAt: props.price,
      capAt: props.marketCap,
      currency: props.currencyCode,
    })
    draft.value = ''
    await load()
  } catch (err) {
    error.value = err
  } finally {
    busy.value = false
  }
}

async function saveEdit(note) {
  await editNote(note.id, { body: editBody.value })
  editingId.value = null
  await load()
}

async function togglePin(note) {
  await editNote(note.id, { pinned: !note.pinned })
  await load()
}

async function destroy(note) {
  if (!confirm('Delete this note? This cannot be undone.')) return
  await removeNote(note.id)
  await load()
}

async function addReminder(days) {
  const due = days ? dueDateFrom(days) : reminderDate.value
  if (!due) return
  try {
    await createReminder({
      symbol: props.symbol,
      dueAt: due,
      body: reminderBody.value.trim() || null,
    })
    // Confirm explicitly. Clicking a preset used to succeed in total silence,
    // which is indistinguishable from it not working.
    reminderNotice.value = `Reminder set for ${new Date(due + 'T00:00:00').toLocaleDateString(
      'en-CA',
      { dateStyle: 'medium' },
    )}`
    setTimeout(() => (reminderNotice.value = null), 6000)
    reminderDate.value = ''
    reminderBody.value = ''
    await load()
  } catch (err) {
    error.value = err
  }
}

async function finish(reminder) {
  await completeReminder(reminder.id)
  await load()
}

async function dropReminder(reminder) {
  await removeReminder(reminder.id)
  await load()
}

const startEdit = (note) => {
  editingId.value = note.id
  editBody.value = note.body
}

/** "3 days ago", "in 2 weeks" — relative time reads faster than a date. */
function relative(iso) {
  if (!iso) return ''
  const diff = Date.parse(iso) - Date.now()
  const abs = Math.abs(diff)
  const day = 86_400_000
  const units = [
    [365 * day, 'year'],
    [30 * day, 'month'],
    [7 * day, 'week'],
    [day, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ]
  for (const [ms, unit] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms)
      const plural = n === 1 ? unit : `${unit}s`
      return diff < 0 ? `${n} ${plural} ago` : `in ${n} ${plural}`
    }
  }
  return 'just now'
}

const absolute = (iso) =>
  iso ? new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : ''

/** Turn bare URLs in a note into links, without rendering arbitrary HTML. */
function segments(text) {
  const out = []
  const re = /(https?:\/\/[^\s<>"']+)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ text: m[0], href: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

const kindLabel = (id) => NOTE_KINDS.find((k) => k.id === id)?.label ?? 'Note'

const openReminders = computed(() => reminders.value.filter((r) => !r.done_at))
const isOverdue = (r) => Date.parse(r.due_at) <= Date.now()
</script>

<template>
  <div class="notes">
    <section class="composer">
      <div class="row kinds">
        <button
          v-for="k in NOTE_KINDS"
          :key="k.id"
          class="chip"
          :class="{ on: kind === k.id }"
          :title="k.hint"
          @click="kind = k.id"
        >
          {{ k.label }}
        </button>
      </div>

      <textarea
        v-model="draft"
        rows="4"
        placeholder="What did you learn? Paste links, note the thesis, record what would change your mind…"
        @keydown.ctrl.enter="submit"
        @keydown.meta.enter="submit"
      />

      <div class="row submit-row">
        <span class="muted tiny">
          <template v-if="price">
            Will be stamped at {{ perShare(price) }}<template v-if="marketCap">
              · {{ currency(marketCap) }}</template>
          </template>
          <template v-else>Ctrl/⌘ + Enter to save</template>
        </span>
        <button class="primary" :disabled="!draft.trim() || busy" @click="submit">
          {{ busy ? 'Saving…' : 'Add note' }}
        </button>
      </div>
    </section>

    <p v-if="error" class="neg tiny">{{ error.message }}</p>

    <section class="reminders">
      <h3>Reminders <span v-if="openReminders.length" class="count">{{ openReminders.length }}</span></h3>

      <div class="composer-r">
        <input
          v-model="reminderBody"
          class="why"
          placeholder="What should you check? (optional)"
          @keydown.enter.prevent="reminderDate && addReminder(null)"
        />
        <div class="row presets">
          <span class="muted tiny">Remind me in</span>
          <button
            v-for="p in REMINDER_PRESETS"
            :key="p.days"
            class="chip"
            @click="addReminder(p.days)"
          >
            {{ p.label }}
          </button>
          <span class="muted tiny or">or on</span>
          <input v-model="reminderDate" type="date" :min="new Date().toISOString().slice(0, 10)" />
          <button :disabled="!reminderDate" @click="addReminder(null)">Set</button>
        </div>
      </div>

      <p v-if="reminderNotice" class="notice-r">
        ✓ {{ reminderNotice }} — it will appear in <RouterLink to="/journal">Journal</RouterLink>,
        and in the nav once it falls due.
      </p>

      <ul v-if="openReminders.length" class="reminder-list">
        <li v-for="r in openReminders" :key="r.id" :class="{ overdue: isOverdue(r) }">
          <span class="when">{{ relative(r.due_at) }}</span>
          <span class="muted date">{{ r.due_at }}</span>
          <span class="body">{{ r.body }}</span>
          <button class="link" @click="finish(r)">Done</button>
          <button class="link muted" @click="dropReminder(r)">Delete</button>
        </li>
      </ul>
      <p v-else class="muted tiny">None set.</p>
    </section>

    <section v-if="notes.length" class="log">
      <h3>{{ notes.length }} note{{ notes.length === 1 ? '' : 's' }}</h3>
      <article v-for="n in notes" :key="n.id" :class="{ pinned: n.pinned }">
        <header>
          <span class="tag">{{ kindLabel(n.kind) }}</span>
          <span class="muted when" :title="absolute(n.created_at)">{{ relative(n.created_at) }}</span>
          <span v-if="n.price_at" class="muted ctx">
            at {{ perShare(n.price_at) }}<template v-if="n.cap_at"> · {{ currency(n.cap_at) }}</template>
          </span>
          <span v-if="n.updated_at !== n.created_at" class="muted ctx">edited</span>
          <span class="spacer" />
          <button class="link" :title="n.pinned ? 'Unpin' : 'Pin to top'" @click="togglePin(n)">
            {{ n.pinned ? '★' : '☆' }}
          </button>
          <button class="link" @click="startEdit(n)">Edit</button>
          <button class="link muted" @click="destroy(n)">Delete</button>
        </header>

        <div v-if="editingId === n.id" class="edit">
          <textarea v-model="editBody" rows="4" />
          <div class="row">
            <button class="primary" @click="saveEdit(n)">Save</button>
            <button @click="editingId = null">Cancel</button>
          </div>
        </div>

        <p v-else class="body">
          <template v-for="(seg, i) in segments(n.body)" :key="i">
            <a v-if="seg.href" :href="seg.href" target="_blank" rel="noopener noreferrer">{{ seg.text }}</a>
            <template v-else>{{ seg.text }}</template>
          </template>
        </p>
      </article>
    </section>

    <p v-else class="muted tiny">No notes yet for {{ name || symbol }}.</p>
  </div>
</template>

<style scoped>
.notes {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
textarea {
  width: 100%;
  font: inherit;
  font-size: 14px;
  line-height: 150%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-h);
  resize: vertical;
  box-sizing: border-box;
}
textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.kinds {
  flex-wrap: wrap;
  gap: 5px;
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

.submit-row {
  justify-content: space-between;
}

h3 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.75;
  margin-bottom: 10px;
}

.composer-r {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.why {
  width: 100%;
  padding: 7px 11px;
  font-size: 13px;
  box-sizing: border-box;
}
.or {
  margin-left: 4px;
}
.count {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--accent-bg);
  color: var(--accent);
  margin-left: 4px;
}
.notice-r {
  margin-top: 8px;
  padding: 7px 11px;
  border: 1px solid var(--accent-border);
  background: var(--accent-bg);
  border-radius: 6px;
  font-size: 12px;
}

.presets {
  flex-wrap: wrap;
  gap: 6px;
}
.presets input[type='date'] {
  padding: 3px 8px;
  font-size: 12px;
}
.reminder-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.reminder-list li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--bg-soft);
}
.reminder-list li.overdue {
  border-left: 2px solid var(--accent);
}
.reminder-list .when {
  font-weight: 600;
  color: var(--text-h);
}
.reminder-list .date {
  font-size: 11px;
  font-family: var(--mono);
}
.reminder-list .body {
  flex: 1;
}

.log {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
article {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
article.pinned {
  border-color: var(--accent-border);
  background: var(--accent-bg);
}
article header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  margin-bottom: 6px;
}
.spacer {
  margin-left: auto;
}
.ctx {
  font-size: 11px;
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
.link:hover {
  text-decoration: underline;
}

.tiny {
  font-size: 12px;
}
</style>
