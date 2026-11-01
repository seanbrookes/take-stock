<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { annotationsFor } from '../stores/annotations.js'

/** Compact "have I looked at this?" markers for a table row. */
const props = defineProps({ symbol: { type: String, required: true } })

const a = computed(() => annotationsFor(props.symbol))
const labels = computed(() => [...a.value.lists, ...a.value.tags].map((x) => x.name).join(', '))
</script>

<template>
  <span v-if="a.notes || a.reminders || a.lists.length || a.tags.length" class="badges">
    <RouterLink
      v-if="a.notes"
      :to="`/stock/${symbol}/notes`"
      class="badge notes"
      :title="`${a.notes} note${a.notes === 1 ? '' : 's'}`"
      @click.stop
    >✎ {{ a.notes }}</RouterLink>

    <RouterLink
      v-if="a.reminders"
      :to="`/stock/${symbol}/notes`"
      class="badge reminder"
      :class="{ overdue: a.overdue }"
      :title="a.overdue ? `${a.overdue} reminder(s) due` : `${a.reminders} upcoming reminder(s)`"
      @click.stop
    >◷ {{ a.reminders }}</RouterLink>

    <span
      v-if="a.lists.length || a.tags.length"
      class="badge lists"
      :title="labels"
    >⛁ {{ a.lists.length + a.tags.length }}</span>
  </span>
</template>

<style scoped>
.badges {
  display: inline-flex;
  gap: 3px;
  margin-left: 6px;
  vertical-align: middle;
}

.badge {
  font-size: 10px;
  font-family: var(--mono);
  padding: 1px 5px;
  border-radius: 8px;
  background: var(--code-bg);
  color: var(--text);
  white-space: nowrap;
}
a.badge:hover {
  text-decoration: none;
  color: var(--accent);
}

.notes {
  color: var(--accent);
  background: var(--accent-bg);
}
.reminder.overdue {
  color: var(--neg);
  background: color-mix(in srgb, var(--neg) 15%, transparent);
}
</style>
