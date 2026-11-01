<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import {
  state,
  loadLists,
  listsFor,
  isInList,
  isWatched,
  toggleList,
  addToList,
  toggleWatch,
  createList,
  listsOnly,
  tagsOnly,
  DEFAULT_LIST,
} from '../stores/lists.js'

/**
 * Watch-list control for the company header — reachable from every tab.
 *
 * The star is a shortcut for the default "Watchlist"; the dropdown covers every
 * other list and creating new ones on the spot.
 */
const props = defineProps({
  symbol: { type: String, required: true },
  /**
   * Inside a table row the membership chips would float over the panel below,
   * and the row already carries badges — so suppress them there.
   */
  compact: { type: Boolean, default: false },
})

const open = ref(false)
const newName = ref('')
const newTag = ref('')
const tagNotice = ref(null)
const error = ref(null)
const root = ref(null)

onMounted(() => {
  if (!state.loaded) loadLists()
  document.addEventListener('click', onOutside, true)
})
onBeforeUnmount(() => document.removeEventListener('click', onOutside, true))

/** Click-away, so the menu does not linger over the page. */
function onOutside(event) {
  if (open.value && root.value && !root.value.contains(event.target)) open.value = false
}

const mine = computed(() => listsFor(props.symbol))
const watching = computed(() => isWatched(props.symbol))

/** The default list is offered by the star, so keep it out of the menu body. */
const others = computed(() => listsOnly.value.filter((g) => g.name !== DEFAULT_LIST))
const tags = computed(() => tagsOnly.value)

async function add() {
  const name = newName.value.trim()
  if (!name) return
  try {
    await createList(name, props.symbol)
    newName.value = ''
    error.value = null
  } catch (err) {
    error.value = err.message
  }
}

/**
 * Tags accept several at once — "agtech, greensteel" — because taxonomy is
 * usually typed in a burst rather than one term at a time. An existing tag is
 * reused rather than duplicated.
 */
async function addTags() {
  const names = newTag.value.split(',').map((t) => t.trim()).filter(Boolean)
  if (!names.length) return

  const reused = []
  const failed = []

  for (const name of names) {
    // Match across BOTH kinds. Names share one namespace, so a tag typed here
    // may already exist as a list — in which case the intent ("label this
    // company agtech") is served by joining that list, not by erroring.
    const existing = state.groups.find((g) => g.name.toLowerCase() === name.toLowerCase())
    try {
      if (existing) {
        await addToList(existing.id, props.symbol)
        if (existing.kind !== 'tag') reused.push(`"${existing.name}" (an existing list)`)
      } else {
        await createList(name, props.symbol, 'tag')
      }
    } catch (err) {
      // One bad name must not discard the rest of what was typed.
      failed.push(`${name}: ${err.message}`)
    }
  }

  newTag.value = ''
  error.value = failed.length ? failed.join('; ') : null
  tagNotice.value = reused.length ? `Added to ${reused.join(', ')}` : null
  if (tagNotice.value) setTimeout(() => (tagNotice.value = null), 6000)
}
</script>

<template>
  <div ref="root" class="lists">
    <button
      :class="{ primary: watching }"
      :title="watching ? `Remove from ${DEFAULT_LIST}` : `Add to ${DEFAULT_LIST}`"
      @click="toggleWatch(symbol)"
    >
      {{ watching ? '★ Watching' : '☆ Watch' }}
    </button>

    <button class="menu-toggle" :class="{ on: open }" @click="open = !open">
      Lists
      <span v-if="mine.length" class="count">{{ mine.length }}</span>
      <span class="caret">▾</span>
    </button>

    <div v-if="open" class="menu" @keydown.escape="open = false">
      <p class="muted tiny">Add {{ symbol }} to</p>

      <label v-for="g in others" :key="g.id" class="item">
        <input type="checkbox" :checked="isInList(symbol, g.id)" @change="toggleList(g.id, symbol)" />
        <span class="name">{{ g.name }}</span>
        <span class="muted n">{{ g.members }}</span>
      </label>
      <p v-if="!others.length" class="muted tiny none">No other lists yet.</p>

      <div class="new">
        <input v-model="newName" placeholder="New list…" @keydown.enter.prevent="add" />
        <button :disabled="!newName.trim()" @click="add">Create</button>
      </div>

      <p class="muted tiny section">Tags</p>
      <div class="tag-row">
        <button
          v-for="t in tags"
          :key="t.id"
          class="tagchip"
          :class="{ on: isInList(symbol, t.id) }"
          @click="toggleList(t.id, symbol)"
        >
          {{ t.name }}
        </button>
        <span v-if="!tags.length" class="muted tiny">None yet.</span>
      </div>
      <div class="new">
        <input
          v-model="newTag"
          placeholder="agtech, greensteel…"
          @keydown.enter.prevent="addTags"
        />
        <button :disabled="!newTag.trim()" @click="addTags">Tag</button>
      </div>

      <p v-if="tagNotice" class="muted tiny">{{ tagNotice }}</p>
      <p v-if="error" class="neg tiny">{{ error }}</p>
    </div>

    <div v-if="mine.length && !compact" class="chips">
      <span v-for="g in mine" :key="g.id" class="tag">{{ g.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.lists {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
}

.menu-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.menu-toggle.on {
  border-color: var(--accent-border);
  color: var(--accent);
}
.count {
  font-size: 11px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent-bg);
  color: var(--accent);
}
.caret {
  font-size: 10px;
  opacity: 0.6;
}

.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  min-width: 240px;
  padding: 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
  text-align: left;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 2px;
  font-size: 13px;
  cursor: pointer;
}
.item input {
  width: auto;
  padding: 0;
  accent-color: var(--accent);
}
.item .name {
  color: var(--text-h);
}
.n {
  margin-left: auto;
  font-size: 11px;
}
.none {
  padding: 4px 2px;
}

.new {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.new input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
}

.chips {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 320px;
  pointer-events: none;
}

.section {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.tagchip {
  padding: 2px 9px;
  font-size: 12px;
  border-radius: 20px;
  background: var(--bg);
}
.tagchip.on {
  color: var(--accent);
  border-color: var(--accent-border);
  background: var(--accent-bg);
}

.tiny {
  font-size: 12px;
}
</style>
