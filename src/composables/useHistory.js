import { ref } from 'vue'
import { getJson } from '../api/http.js'
import { mapLimit } from '../api/questrade.js'

/**
 * Lazy price history for a list of rows.
 *
 * Two layers of caching, doing different jobs:
 *
 *  - SQLite (server side) decides whether Questrade is called at all. History
 *    keeps for half a day, so reopening a view costs no API budget regardless
 *    of browser session.
 *  - An in-memory memo decides whether a *request* is made at all. Revisiting a
 *    sector fills its sparklines synchronously from what this page load has
 *    already seen.
 *
 * A "once per session" flag was the obvious way to do the second part, and it
 * was wrong: the flag outlives a page reload but the row objects do not, so a
 * reloaded page skipped the sweep and rendered blank charts over a perfectly
 * warm cache. The memo is tied to the same lifetime as the rows it fills.
 *
 * A manual reload bypasses both layers.
 */

/** symbolId -> closes[], for this page load only. */
const memo = new Map()

/** symbolId -> closes[] for the long-range chart, cached separately. */
const memoLong = new Map()

export function fetchHistory(symbolId, range = '1m', force = false) {
  return getJson(
    `/api/db/candles?symbolId=${symbolId}&range=${range}${force ? '&force=1' : ''}`,
    { ttl: 0 }, // the server owns caching; a second client cache only confuses things
  )
}

export function useHistory({ range = '1m', concurrency = 4, max = 200, longRange = null } = {}) {
  const loading = ref(false)
  const longLoading = ref(false)
  const done = ref(0)
  const total = ref(0)
  const fromCache = ref(0)
  const failed = ref(0)
  const skipped = ref(0)

  /**
   * Sweeps supersede each other rather than queueing.
   *
   * The first version bailed out with `if (loading) return`, so switching
   * sector while a sweep was still running silently dropped the new one — and
   * with Mining at 1,080 rows taking ~90s, every sector clicked during that
   * window got no sparklines at all. An in-flight sweep also writes onto row
   * objects that `load()` has already replaced, so its results land nowhere.
   * A generation counter fixes both: the newest sweep wins, and stale writes
   * are discarded.
   */
  let generation = 0

  /**
   * @param {Array} rows   reactive rows carrying symbolId; mutated in place
   * @param {{force?: boolean}} [opts]
   */
  async function sweep(rows, { force = false } = {}) {
    const mine = ++generation

    if (force) {
      memo.clear()
      memoLong.clear()
    }

    // Fill from the memo first — instant, no request, no flicker on revisit.
    for (const row of rows) {
      if (!row.symbolId) continue
      if (!row.spark) {
        const closes = memo.get(row.symbolId)
        if (closes?.length > 1) {
          row.spark = closes
          row.sparkChange = (closes.at(-1) - closes[0]) / closes[0]
        }
      }
      if (longRange && !row.sparkLong) {
        const closes = memoLong.get(row.symbolId)
        if (closes?.length > 1) {
          row.sparkLong = closes
          row.sparkLongChange = (closes.at(-1) - closes[0]) / closes[0]
        }
      }
    }

    // A memoised empty result means "asked, genuinely no data" — not a gap to
    // re-request. Without this, symbols with no trades are retried every visit.
    const eligible = rows.filter((r) => r.symbolId && !r.spark && !memo.has(r.symbolId))
    const eligibleLong = longRange
      ? rows.filter((r) => r.symbolId && !r.sparkLong && !memoLong.has(r.symbolId))
      : []
    if (!eligible.length && !eligibleLong.length) return

    // Rows arrive in display order (market cap first by default), so the cap
    // covers the companies actually worth looking at. Sweeping all 1,080 mining
    // shells would spend ~7% of the hourly API budget on sub-$10M listings.
    const targets = eligible.slice(0, max)
    const longTargets = longRange ? eligibleLong.slice(0, max) : []

    // The 30-day sweep owns the shared counters, because the totals line
    // ("charts cover the largest N") is about the primary sparkline. The
    // long-range sweep tracks its own loading flag, not these numbers.
    loading.value = true
    done.value = 0
    total.value = targets.length
    skipped.value = eligible.length - targets.length
    fromCache.value = 0
    failed.value = 0

    await mapLimit(
      targets,
      concurrency,
      // Short-circuits the remaining work the moment a newer sweep starts.
      (row) => (mine === generation ? fetchHistory(row.symbolId, range, force) : null),
      (row, result) => {
        if (mine !== generation) return // superseded; row may be detached
        done.value++
        if (!result) {
          failed.value++
          return
        }
        if (result.cached) fromCache.value++
        const closes = (result.candles ?? []).map((c) => c.close).filter(Number.isFinite)
        if (closes.length > 1) {
          memo.set(row.symbolId, closes)
          // Assigned onto the row so the table renders each sparkline as it lands.
          row.spark = closes
          row.sparkChange = (closes.at(-1) - closes[0]) / closes[0]
        } else {
          // Remember the empty answer too, or every revisit re-asks for a
          // symbol that genuinely has no trades.
          memo.set(row.symbolId, [])
        }
      },
    )

    if (mine !== generation) return // a newer sweep owns the state now
    loading.value = false

    if (longRange && longTargets.length) {
      // The long-range chart is a separate, slower set of requests. It shares
      // the same max cap so a sector click does not double the API spend — the
      // same top-N companies get both charts.
      longLoading.value = true
      await mapLimit(
        longTargets,
        concurrency,
        (row) => (mine === generation ? fetchHistory(row.symbolId, longRange, force) : null),
        (row, result) => {
          if (mine !== generation) return
          const closes = (result?.candles ?? []).map((c) => c.close).filter(Number.isFinite)
          if (closes.length > 1) {
            memoLong.set(row.symbolId, closes)
            row.sparkLong = closes
            row.sparkLongChange = (closes.at(-1) - closes[0]) / closes[0]
          } else {
            memoLong.set(row.symbolId, [])
          }
        },
      )
      if (mine !== generation) return
      longLoading.value = false
    }
  }

  return { sweep, loading, longLoading, done, total, fromCache, failed, skipped }
}
