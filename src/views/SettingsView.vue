<script setup>
import { ref, computed, onMounted } from 'vue'
import { clearCache, cacheStats } from '../api/http.js'
import { checkQuestrade } from '../api/questrade.js'
import { state as listState, loadLists } from '../stores/lists.js'

const stats = ref(cacheStats())
const questrade = ref({ ok: false, error: 'checking…' })

/** "Not configured" would be a lie when auth succeeds and only a scope is missing. */
const questradeStatus = computed(() => {
  if (questrade.value.ok) return 'Connected'
  if (questrade.value.scopeProblem) return 'Authenticated · missing scope'
  return 'Not configured'
})

onMounted(async () => {
  loadLists()
  questrade.value = await checkQuestrade()
})

function purge() {
  clearCache()
  stats.value = cacheStats()
}

function exportWatchlist() {
  const payload = listState.groups.map((g) => ({
    name: g.name,
    members: Object.entries(listState.bySymbol)
      .filter(([, gs]) => gs.some((x) => x.id === g.id))
      .map(([symbol]) => symbol),
  }))
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'take-stock-watchlist.json'
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="stack">
    <h1>Settings</h1>

    <section class="card">
      <h2>Data sources</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Source</th><th>Provides</th><th>Coverage</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><span class="tag">SEC EDGAR</span></td>
              <td>Financial statements, filings</td>
              <td>US filers + cross-listed Canadians (40-F)</td>
              <td class="pos">Live · keyless</td>
            </tr>
            <tr>
              <td><span class="tag">Questrade</span></td>
              <td>Prices, market cap, P/E, yield</td>
              <td>All TSX / TSXV / US listings</td>
              <td :class="questrade.ok ? 'pos' : 'neg'">{{ questradeStatus }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="questrade.scopeProblem" class="setup">
        <h3>Authenticated, but missing a scope</h3>
        <p class="small">
          The token works — Questrade is rejecting <em>symbol lookup</em> specifically. Its
          <code>symbols/*</code> endpoints sit under the
          <strong>“Retrieve balances, positions, orders and executions”</strong> scope, not the
          market-data one, so without it no ticker can be resolved and nothing else works.
        </p>
        <ol>
          <li>App Hub → pencil icon on your app → tick that scope alongside market data → save.</li>
          <li>
            Click <strong>+ New device</strong> for a <em>new</em> token. Scopes are bound to the
            authorization, so an existing token is never upgraded by editing the app.
          </li>
          <li>Put the new token in <code>.env.local</code> and restart <code>npm run dev</code>.</li>
        </ol>
        <p class="muted small">{{ questrade.error }}</p>
      </div>

      <div v-else-if="!questrade.ok" class="setup">
        <h3>Connect Questrade</h3>
        <p class="muted small">
          The API Centre is <strong>not</strong> in the trading platform — it is a separate
          portal, and API access is off until you activate it.
        </p>
        <ol>
          <li>
            Go to
            <a href="https://apphub.questrade.com/UI/UserApps.aspx" target="_blank" rel="noopener">
              apphub.questrade.com</a
            >, or use the drop-down under your login name (top right of questrade.com) and pick
            <strong>API centre</strong>.
          </li>
          <li>Click <strong>Activate API</strong> and accept the API access agreement.</li>
          <li>
            Click <strong>Register a personal app</strong>, give it a name and description, save.
          </li>
          <li>
            In the app's <strong>Authorizations</strong> section click
            <strong>+ New device</strong> and name it (e.g. <code>take-stock local</code>). That
            is the only token-minting action in the current App Hub. The
            <em>Consumer key</em> on the app page is the OAuth <code>client_id</code> and is
            <strong>not</strong> what this app uses.
          </li>
          <li>
            <strong>Copy the refresh token before closing the dialog.</strong> Questrade does not
            keep it in readable form, so it is shown once — miss it and you must generate another.
          </li>
          <li>
            Put it in <code>.env.local</code> in the project root:<br />
            <code>QUESTRADE_REFRESH_TOKEN=your-token-here</code>
          </li>
          <li>Restart <code>npm run dev</code>.</li>
        </ol>
        <p class="muted small">
          The token is held by the dev server, never the browser — it can read your account, and
          Questrade rotates it on every refresh, so it must be persisted server-side. Tokens are
          single-use and lapse after a few days unused; if auth breaks, generate a new one.
        </p>
        <p v-if="questrade.error" class="muted small mono">{{ questrade.error }}</p>
      </div>
    </section>

    <section class="card">
      <h2>Known gaps</h2>
      <ul class="gaps">
        <li>
          <strong>TSX-only companies have no fundamentals.</strong> Canada does not mandate
          XBRL — SEDAR+ hosts PDFs and has no public API — so financial statements are only
          available for companies that also file with the SEC.
        </li>
        <li>
          Valuation ratios are suppressed when a company trades in one currency and reports in
          another, rather than silently mixing them.
        </li>
      </ul>
    </section>

    <section class="card">
      <h2>Cache</h2>
      <p class="muted">
        {{ stats.entries }} cached response(s), {{ stats.inflight }} in flight. Filing data is
        cached in memory for 6 hours.
      </p>
      <div class="row">
        <button @click="purge">Clear cache</button>
        <button @click="stats = cacheStats()">Refresh stats</button>
      </div>
    </section>

    <section class="card">
      <h2>Watch lists</h2>
      <p class="muted">
        {{ listState.groups.length }} list(s) in the local database.
        Notes, reminders and lists all live in <code>data/take-stock.db</code> — the only data
        here that cannot be refetched, so it is worth backing up.
      </p>
      <button :disabled="!listState.groups.length" @click="exportWatchlist">Export JSON</button>
    </section>
  </div>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}

.setup {
  border-top: 1px solid var(--border);
  padding-top: 12px;
  width: 100%;
}

.setup ol {
  margin: 8px 0;
  padding-left: 20px;
  font-size: 14px;
  line-height: 180%;
}

.gaps {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 165%;
  max-width: 80ch;
}

.small {
  font-size: 12px;
  max-width: 75ch;
}
</style>
