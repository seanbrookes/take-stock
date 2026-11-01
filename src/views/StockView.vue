<script setup>
import { computed, provide, ref, toRef } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { resolveSymbol, fetchSubmissions, fetchCompanyFactsOrNull } from '../api/sec.js'
import { searchSymbols, fetchSymbol, findSecFiler } from '../api/questrade.js'
import { ApiError } from '../api/http.js'
import { computeFundamentals, computeTTM } from '../analysis/metrics.js'
import { useAsyncData } from '../composables/useAsyncData.js'
import { COMPANY_KEY } from '../composables/useCompany.js'
import ListsButton from '../components/ListsButton.vue'
import StateBlock from '../components/StateBlock.vue'
import { researchUrl } from '../analysis/research-link.js'

const props = defineProps({ symbol: { type: String, required: true } })
const route = useRoute()
const symbol = toRef(props, 'symbol')

/** Annual vs quarterly applies across every tab, so it lives on the shell. */
const period = ref('annual')

const { data, error, loading, refresh } = useAsyncData(async () => {
  const ticker = symbol.value.toUpperCase()

  // 1. Questrade first: it covers every TSX/TSXV listing plus US names, so it
  //    defines the universe. Absent or unconfigured, we fall back to SEC alone.
  let listing = null
  let quote = null
  let questradeError = null
  try {
    const matches = await searchSymbols(ticker)
    listing = matches.find((m) => m.symbol.toUpperCase() === ticker) ?? matches[0] ?? null
    if (listing) quote = await fetchSymbol(listing.symbolId)
  } catch (err) {
    // Keep the reason. Discarding it turned any transient Questrade failure —
    // a rate-limit wait, a timeout while a universe refresh held the queue —
    // into "Nothing found for CNR.TO", which points at the wrong problem
    // entirely and suggests the symbol does not exist.
    questradeError = err
    listing = null
  }

  // 2. SEC fundamentals, when this company files with the SEC at all. The
  //    name guard in findSecFiler is what stops L.TO (Loblaw) from picking up
  //    Loews' financials.
  //
  //    With no Questrade listing there is no company name to guard with, so a
  //    Canadian ticker is only looked up in SEC's index as-is. Stripping ".TO"
  //    and matching on the root would attach Loews' filings to Loblaw.
  const filer = listing ? await findSecFiler(listing) : await resolveSymbol(ticker)

  let submissions = null
  let facts = null
  if (filer) {
    // Settled independently: a filer can have submissions but no XBRL (see
    // fetchCompanyFactsOrNull), and neither absence should fail the page.
    const [subs, xbrl] = await Promise.allSettled([
      fetchSubmissions(filer.cik),
      fetchCompanyFactsOrNull(filer.cik),
    ])
    submissions = subs.status === 'fulfilled' ? subs.value : null
    facts = xbrl.status === 'fulfilled' ? xbrl.value : null
  }

  if (!listing && !filer) {
    if (questradeError) {
      throw new ApiError(
        `Could not load ${ticker} from Questrade: ${questradeError.message}` +
          (/timed out|timeout/i.test(questradeError.message)
            ? ' — a universe refresh may be holding the request queue; try again shortly.'
            : ''),
        { url: questradeError.url },
      )
    }
    throw new ApiError(
      `Nothing found for "${ticker}". Questrade covers TSX/TSXV listings — check it is ` +
        `configured in Settings — and SEC EDGAR covers US filers.`,
    )
  }

  return { listing, quote, filer, submissions, facts }
})

const hasFundamentals = computed(() => Boolean(data.value?.facts))

const fundamentals = computed(() =>
  data.value?.facts ? computeFundamentals(data.value.facts, { period: period.value }) : null,
)
const ttm = computed(() => (data.value?.facts ? computeTTM(data.value.facts) : null))

provide(COMPANY_KEY, {
  data,
  fundamentals,
  ttm,
  period,
  loading,
  error,
  refresh,
  hasFundamentals,
})

const displayName = computed(
  () =>
    data.value?.submissions?.name ??
    data.value?.listing?.description ??
    symbol.value.toUpperCase(),
)

/** Tabs that need filing data disappear when the company does not file. */
const tabs = computed(() => {
  const all = [
    { name: 'stock', label: 'Overview', needsFacts: false },
    { name: 'stock-prices', label: 'Prices', needsFacts: false },
    { name: 'stock-notes', label: 'Notes', needsFacts: false },
    { name: 'stock-financials', label: 'Financials', needsFacts: true },
    { name: 'stock-raw', label: 'Raw data', needsFacts: true },
  ]
  return all.filter((t) => !t.needsFacts || hasFundamentals.value)
})

const listing = computed(() => data.value?.listing ?? null)
const sub = computed(() => data.value?.submissions ?? null)

/** Lives on the shell so it is reachable from every tab, not just Notes. */
const research = computed(() =>
  researchUrl({
    symbol: listing.value?.symbol ?? symbol.value,
    name: displayName.value,
    sector: listing.value?.industrySector ?? sub.value?.sicDescription ?? '',
  }),
)
</script>

<template>
  <StateBlock
    :loading="loading"
    :error="error"
    :label="`Loading ${symbol.toUpperCase()}…`"
    @retry="refresh"
  >
    <div class="stack">
      <div class="head">
        <div>
          <h1>{{ displayName }}</h1>
          <p class="sub muted">
            <span class="tag">{{ listing?.symbol ?? symbol.toUpperCase() }}</span>
            <span v-if="listing?.listingExchange">{{ listing.listingExchange }}</span>
            <span v-if="listing?.currency">{{ listing.currency }}</span>
            <span v-if="sub?.sicDescription">{{ sub.sicDescription }}</span>
            <span v-else-if="listing?.industrySector">{{ listing.industrySector }}</span>
          </p>
        </div>

        <div class="row">
          <a
            :href="research"
            target="_blank"
            rel="noopener noreferrer"
            class="research"
            :title="`Research ${displayName} in Google AI Mode`"
          >
            Research ↗
          </a>
          <select v-if="hasFundamentals" v-model="period" aria-label="Reporting period">
            <option value="annual">Annual</option>
            <option value="quarterly">Quarterly</option>
          </select>
          <ListsButton :symbol="listing?.symbol ?? symbol.toUpperCase()" />
        </div>
      </div>

      <p v-if="!hasFundamentals" class="notice">
        <strong>Prices only.</strong>
        No SEC financial statements for this company, so there is nothing to analyse beyond
        price. That is the TSX-only coverage gap: it either does not file with the SEC at all,
        or its only US presence is an unsponsored ADR, which carries a ticker but no filings.
        Fundamentals need a real US cross-listing or a commercial Canadian data provider.
      </p>

      <nav class="tabs">
        <RouterLink
          v-for="tab in tabs"
          :key="tab.name"
          :to="{ name: tab.name, params: { symbol } }"
          :class="{ on: route.name === tab.name }"
        >
          {{ tab.label }}
        </RouterLink>
      </nav>

      <RouterView />
    </div>
  </StateBlock>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  font-size: 13px;
}

.research {
  font-size: 13px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-h);
  white-space: nowrap;
}
.research:hover {
  text-decoration: none;
  border-color: var(--accent-border);
  color: var(--accent);
}

.notice {
  border: 1px solid var(--accent-border);
  background: var(--accent-bg);
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
}

.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}

.tabs a {
  padding: 8px 14px;
  font-size: 14px;
  color: var(--text);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tabs a:hover {
  text-decoration: none;
  color: var(--text-h);
}
.tabs a.on {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
</style>
