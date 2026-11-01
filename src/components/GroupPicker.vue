<script setup>
import { computed, ref, onMounted } from 'vue'
import {
  fetchGroups,
  createGroup,
  addSymbolToGroup,
  removeSymbolFromGroup,
  fetchGroupMembers,
} from '../api/journal.js'

/**
 * Custom lists, created on the fly. A stock can sit in several at once —
 * "deep value" and "watch for earnings" are not mutually exclusive.
 */
const props = defineProps({ symbol: { type: String, required: true } })
const emit = defineEmits(['changed'])

const groups = ref([])
const memberships = ref([])
const newName = ref('')
const open = ref(false)
const error = ref(null)

async function load() {
  const [g, m] = await Promise.all([fetchGroups(), fetchGroupMembers()])
  groups.value = g.groups
  memberships.value = m.members.filter((x) => x.symbol === props.symbol)
}
onMounted(load)

const inGroup = (id) => memberships.value.some((m) => m.id === id)

async function toggle(group) {
  if (inGroup(group.id)) await removeSymbolFromGroup(group.id, props.symbol)
  else await addSymbolToGroup(group.id, props.symbol)
  await load()
  emit('changed')
}

async function addNew() {
  const name = newName.value.trim()
  if (!name) return
  try {
    const group = await createGroup({ name })
    await addSymbolToGroup(group.id, props.symbol)
    newName.value = ''
    error.value = null
    await load()
    emit('changed')
  } catch (err) {
    error.value = err.message
  }
}

const mine = computed(() => memberships.value.map((m) => m.name))
</script>

<template>
  <div class="picker">
    <button class="toggle" @click="open = !open">
      <template v-if="mine.length">
        <span v-for="n in mine" :key="n" class="tag">{{ n }}</span>
      </template>
      <span v-else class="muted">+ Add to list</span>
    </button>

    <div v-if="open" class="menu" @keydown.escape="open = false">
      <p class="muted tiny">Lists</p>
      <label v-for="g in groups" :key="g.id" class="item">
        <input type="checkbox" :checked="inGroup(g.id)" @change="toggle(g)" />
        <span>{{ g.name }}</span>
        <span class="muted count">{{ g.members }}</span>
      </label>
      <p v-if="!groups.length" class="muted tiny">None yet — create one below.</p>

      <div class="new">
        <input
          v-model="newName"
          placeholder="New list name…"
          @keydown.enter.prevent="addNew"
        />
        <button :disabled="!newName.trim()" @click="addNew">Create</button>
      </div>
      <p v-if="error" class="neg tiny">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
}

.toggle {
  display: flex;
  gap: 5px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 13px;
  background: none;
}

.menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 230px;
  padding: 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  font-size: 13px;
  cursor: pointer;
}
.item input {
  width: auto;
  padding: 0;
  accent-color: var(--accent);
}
.count {
  margin-left: auto;
  font-size: 11px;
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
  padding: 4px 8px;
  font-size: 13px;
  min-width: 0;
}

.tiny {
  font-size: 12px;
}
</style>
