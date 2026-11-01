<script setup>
import { RouterLink, RouterView, useRoute } from 'vue-router'
import TickerSearch from './components/TickerSearch.vue'
import { ref, onMounted } from 'vue'
import { fetchDueReminders } from './api/journal.js'
import { loadLists, migrateLegacyWatchlist } from './stores/lists.js'

const route = useRoute()

// A reminder you never see is not a reminder; surface the count in the nav.
const dueCount = ref(0)
onMounted(async () => {
  // One concept for watch lists now; move anything starred under the old
  // localStorage scheme into the database, once.
  await migrateLegacyWatchlist()
  await loadLists()
  try {
    dueCount.value = (await fetchDueReminders()).due.length
  } catch {
    /* database not ready — the badge is optional */
  }
})
</script>

<template>
  <div class="page" :class="{ wide: route.meta.wide }">
    <header>
    <RouterLink to="/" class="brand">take·stock</RouterLink>
    <TickerSearch />
    <nav>
      <RouterLink to="/">Watchlist</RouterLink>
      <RouterLink to="/tsx60">TSX 60</RouterLink>
      <RouterLink to="/screener">Screener</RouterLink>
      <RouterLink to="/sectors">Sectors</RouterLink>
      <RouterLink to="/journal" class="journal">
        Journal
        <span v-if="dueCount" class="due" :title="`${dueCount} reminder(s) due`">{{ dueCount }}</span>
      </RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
    </nav>
    </header>

    <main>
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
header {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 14px 0;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--border);
}

.brand {
  font-weight: 600;
  font-size: 17px;
  color: var(--text-h);
  letter-spacing: -0.02em;
  flex-shrink: 0;
}
.brand:hover {
  text-decoration: none;
  color: var(--accent);
}

nav {
  display: flex;
  gap: 16px;
  margin-left: auto;
  font-size: 14px;
}
nav a {
  color: var(--text);
}
nav a.router-link-exact-active {
  color: var(--accent);
}

.journal {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.due {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  header {
    flex-wrap: wrap;
  }
}
</style>
