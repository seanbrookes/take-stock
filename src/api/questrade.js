/**
 * Questrade market data — the Canadian side of the app.
 *
 * Questrade covers every TSX and TSXV listing, which SEC EDGAR does not, but it
 * provides only prices and a snapshot (market cap, P/E, EPS, dividend, yield).
 * There are no financial statements and no history of any of those figures, so
 * it complements SEC fundamentals rather than replacing them.
 *
 * All calls go through the dev-server plugin at /api/qt, which owns the OAuth
 * session — see vite-plugins/questrade.js for why that cannot live here.
 */
import { getJson, ApiError } from './http.js'
import { loadTickerIndex, searchCompanies } from './sec.js'
import { withCategory, DEFAULT_CATEGORIES } from './classify.js'

/** Questrade quotes are delayed unless the account holds a market data package. */
export async function searchSymbols(prefix) {
  if (!prefix?.trim()) return []
  const body = await getJson(`/api/qt/symbols/search?prefix=${encodeURIComponent(prefix.trim())}`, {
    ttl: 60_000,
  })
  return body.symbols ?? []
}

/** Full snapshot for one symbol id: marketCap, pe, eps, dividend, yield, etc. */
export async function fetchSymbol(symbolId) {
  const body = await getJson(`/api/qt/symbols/${symbolId}`, { ttl: 5 * 60_000 })
  return body.symbols?.[0] ?? null
}

/**
 * Resolve many tickers in a single request. Far better than N searches: the
 * response carries the full snapshot (marketCap, pe, eps, yield, 52-week range,
 * sector) for every symbol at once.
 *
 * @param {string[]} names e.g. ['SHOP.TO', 'ENB.TO']
 */
export async function fetchSymbolsByNames(names) {
  if (!names.length) return []
  const out = []
  // Chunked to keep the query string well inside any URL length limit.
  for (const chunk of chunked(names, 40)) {
    const body = await getJson(`/api/qt/symbols?names=${encodeURIComponent(chunk.join(','))}`, {
      ttl: 5 * 60_000,
    })
    out.push(...(body.symbols ?? []))
  }
  return out
}

/** Live quotes for many symbol ids at once. */
export async function fetchQuotes(ids) {
  if (!ids.length) return []
  const out = []
  for (const chunk of chunked(ids, 60)) {
    const body = await getJson(`/api/qt/markets/quotes?ids=${chunk.join(',')}`, { ttl: 20_000 })
    out.push(...(body.quotes ?? []))
  }
  return out
}

function* chunked(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size)
}

/**
 * Run an async mapper over items with bounded concurrency.
 *
 * Candles have no batch endpoint, so a 60-row table means 60 requests.
 * Questrade caps market data at roughly 20 requests/second and will start
 * rejecting beyond that, so these are deliberately throttled. `onResult` lets
 * the caller render each row as it lands instead of waiting for all of them.
 */
export async function mapLimit(items, limit, mapper, onResult) {
  const results = new Array(items.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      try {
        results[i] = await mapper(items[i], i)
      } catch {
        results[i] = null // one failed row must not kill the table
      }
      onResult?.(items[i], results[i], i)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/*
 * Candle size per range. Mirrors CANDLE_RANGES in vite-plugins/questrade.js,
 * which serves the cached path — keep the two in step or the same range shows a
 * different chart depending on which one answered.
 */
const INTERVALS = {
  '1d': 'FiveMinutes',
  '5d': 'FifteenMinutes',
  '1m': 'OneDay',
  '6m': 'OneDay',
  '1y': 'OneDay',
  '5y': 'OneWeek',
  max: 'OneMonth',
}

/*
 * Calendar days, padded past the nominal window: markets are shut on weekends
 * and holidays, so an unpadded 5-day request lands on three sessions after a
 * long weekend, and an unpadded 1-day request returns nothing at all before
 * Monday's open.
 */
const RANGE_DAYS = { '1d': 4, '5d': 9, '1m': 31, '6m': 183, '1y': 365, '5y': 1826, max: 7305 }

/** Ranges whose candles are stale within minutes rather than at the close. */
export const INTRADAY_RANGES = new Set(['1d', '5d'])

/**
 * How many trading sessions each intraday range is supposed to show.
 *
 * The request window is padded in calendar days so a weekend or holiday cannot
 * starve it, which means it reliably returns *too much*: a 4-day window asked
 * for on a Friday comes back with five sessions. Trimming happens here, after
 * the fact, because only the response knows which days actually traded — a
 * calendar cannot tell you the market was shut for Victoria Day.
 */
export const RANGE_SESSIONS = { '1d': 1, '5d': 5 }

/** Keep only the last N distinct session dates in a candle series. */
export function trimToSessions(candles, sessions) {
  if (!sessions || !candles?.length) return candles ?? []
  const dayOf = (c) => String(c.end ?? '').slice(0, 10)
  const dates = [...new Set(candles.map(dayOf))].sort()
  if (dates.length <= sessions) return candles
  const keep = new Set(dates.slice(-sessions))
  return candles.filter((c) => keep.has(dayOf(c)))
}

/**
 * Daily/weekly/monthly candles. Questrade wants ISO-8601 timestamps *with* a
 * timezone offset; a bare Z is rejected, so build them from a real offset.
 */
export async function fetchCandles(symbolId, range = '1y') {
  const end = new Date()
  const start = new Date(end.getTime() - (RANGE_DAYS[range] ?? 365) * 86_400_000)

  const params = new URLSearchParams({
    startTime: isoWithOffset(start),
    endTime: isoWithOffset(end),
    interval: INTERVALS[range] ?? 'OneDay',
  })

  // Intraday moves inside the old ten-minute window, so the cache has to be
  // shorter than the thing it is caching.
  const ttl = INTRADAY_RANGES.has(range) ? 60_000 : 10 * 60_000
  const body = await getJson(`/api/qt/markets/candles/${symbolId}?${params}`, { ttl })
  return trimToSessions(body.candles ?? [], RANGE_SESSIONS[range])
}

function isoWithOffset(date) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return `${local.toISOString().slice(0, 19)}${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
}

// ---------------------------------------------------------------------------
// Linking a Questrade listing to its SEC filer
// ---------------------------------------------------------------------------

const NOISE = new Set([
  'inc', 'corp', 'corporation', 'ltd', 'limited', 'plc', 'co', 'company',
  'holdings', 'holding', 'group', 'the', 'and', 'of', 'sa', 'nv', 'ag',
  'class', 'common', 'shares', 'trust', 'reit', 'lp', 'partners',
  'companies', 'cos', 'incorporated', 'international',
])

const significantWords = (name) =>
  new Set(
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !NOISE.has(w)),
  )

/**
 * Do these two company names plausibly describe the same company?
 *
 * This guard exists because stripping the exchange suffix and matching on
 * ticker alone is actively dangerous: TSX `L.TO` is Loblaw but SEC `L` is
 * Loews, `T.TO` is Telus but SEC `T` is AT&T, and `MG.TO` is Magna but SEC
 * `MG` is Mistras. Silently attaching the wrong company's financials to a
 * ticker is the worst failure this app could have.
 */
export function namesMatch(a, b) {
  const wordsA = significantWords(a)
  const wordsB = significantWords(b)
  if (!wordsA.size || !wordsB.size) return false

  let shared = 0
  for (const w of wordsA) if (wordsB.has(w)) shared++
  if (shared === 0) return false

  const min = Math.min(wordsA.size, wordsB.size)
  if (shared / min < 0.5) return false

  // One shared word is only enough when that word IS the whole name on both
  // sides. Otherwise "Constellation Software" would match "Constellation
  // Brands", and "Brookfield Corp" would match "Brookfield Renewable".
  return shared >= 2 || (wordsA.size === 1 && wordsB.size === 1)
}

/**
 * Find the SEC filer backing a Questrade listing, or null when the company
 * does not file with the SEC (most TSX-only names).
 *
 * @param {{symbol: string, description: string}} listing
 */
/**
 * Unsponsored ADR stubs carry a CIK and a ticker but never any XBRL: SEC has
 * "PrairieSky Royalty Ltd/ADR" on OTC with zero filings behind it. Matching one
 * yields a filer that produces nothing, so they are excluded — the company is
 * then correctly reported as having no SEC fundamentals.
 */
const isAdrStub = (name) => /\/ADR\b/i.test(name) || /\bUNSPON(SORED)?\b/i.test(name)

export async function findSecFiler(listing) {
  const base = String(listing.symbol).split('.')[0].toUpperCase()
  const all = await loadTickerIndex()
  const index = all.filter((r) => !isAdrStub(r.name))
  const candidates = index.filter((r) => r.ticker === base)

  for (const candidate of candidates) {
    if (namesMatch(candidate.name, listing.description)) return candidate
  }

  // Ticker did not match, or matched the wrong company — fall back to matching
  // on name, which catches cases like CNR.TO -> CNI (Canadian National Railway).
  const byName = index.find((r) => namesMatch(r.name, listing.description))
  return byName ?? null
}

// ---------------------------------------------------------------------------
// Combined search
// ---------------------------------------------------------------------------

const toRow = (s) =>
  withCategory({
    ticker: s.symbol,
    name: s.description,
    exchange: s.listingExchange,
    currency: s.currency,
    securityType: s.securityType,
  })

/**
 * Is this result actually relevant to what was typed?
 *
 * Questrade's search matches on symbol, not company name: searching
 * "Canadian Natural Resources" returns 20 unrelated tickers (AGH.H.VN,
 * BK.PRA.TO...) rather than an empty list, and searching just "Canadian"
 * returns the identical 20. Passing that through unfiltered means a name
 * search silently shows the wrong companies.
 *
 * @returns {number|null} sort rank, or null when it is not a match at all
 */
function relevance(row, query) {
  const q = query.trim().toLowerCase()
  const symbol = row.ticker.toLowerCase()
  const name = (row.name ?? '').toLowerCase()
  const base = symbol.split('.')[0]

  if (symbol === q || base === q) return 0
  if (symbol.startsWith(q)) return 1

  const words = q.split(/\s+/).filter(Boolean)
  if (words.length && words.every((w) => name.includes(w))) return 2
  return null
}

/**
 * Primary listings first. Unsponsored OTC lines (PINX) for Canadian companies
 * — CNSWF for Constellation, LOBLY for Loblaw — are thin, in the wrong
 * currency, and file nothing with the SEC, so they should never outrank the
 * TSX listing of the same company.
 */
const PRIMARY_EXCHANGES = new Set(['TSX', 'TSXV', 'NYSE', 'NASDAQ', 'NEO', 'AMEX', 'ARCA'])
const exchangeRank = (row) => (PRIMARY_EXCHANGES.has(row.exchange) ? 0 : 1)

const rank = (rows, query) =>
  rows
    .map((row) => ({ row, score: relevance(row, query) }))
    .filter((r) => r.score !== null)
    .sort(
      (a, b) =>
        a.score - b.score ||
        exchangeRank(a.row) - exchangeRank(b.row) ||
        a.row.ticker.length - b.row.ticker.length,
    )
    .map((r) => r.row)

/**
 * Search that works for both tickers and company names.
 *
 * Questrade owns the tradable universe but cannot search by name; SEC's index
 * searches names well but knows only US filers. So when Questrade returns
 * nothing relevant, we resolve the name through SEC and convert each hit back
 * into real listings via its ticker — which is how "Canadian Natural
 * Resources" ends up offering CNQ.TO on the TSX.
 *
 * @returns {Promise<{rows: Array, source: string, degraded: string|null}>}
 */
export async function searchListings(query, { categories = DEFAULT_CATEGORIES } = {}) {
  const q = query.trim()
  if (!q) return { rows: [], source: '', degraded: null, filtered: 0 }

  const allowed = new Set(categories)
  // An empty selection means "no filter" rather than "show nothing", which is
  // the less surprising reading of unticking every box.
  const keep = (rows) => (allowed.size ? rows.filter((r) => allowed.has(r.category)) : rows)

  let questradeUp = true
  let degraded = null
  let listings = []

  try {
    listings = (await searchSymbols(q)).filter((s) => s.isTradable !== false).map(toRow)
  } catch (err) {
    questradeUp = false
    degraded = /1016|OAuth scopes/.test(err?.message ?? '')
      ? 'Questrade token lacks the symbol-lookup scope — see Settings. No TSX results.'
      : 'Questrade unavailable — US SEC filers only, no TSX results.'
  }

  const direct = rank(listings, q)
  if (direct.length) {
    const shown = keep(direct)
    return {
      rows: shown.slice(0, 12),
      source: 'Questrade',
      degraded,
      // Surfaced in the UI so an active filter never looks like "no results".
      filtered: direct.length - shown.length,
    }
  }

  // Nothing matched — fall back to a name search over SEC's index.
  const hits = await searchCompanies(q, 4)
  const rows = []
  const seen = new Set()

  for (const hit of hits) {
    let expanded = []
    if (questradeUp) {
      try {
        // The SEC ticker is the US symbol; asking Questrade for it surfaces
        // both the US listing and its Canadian twin (CNQ -> CNQ, CNQ.TO).
        expanded = (await searchSymbols(hit.ticker))
          .filter((s) => s.isTradable !== false && s.symbol.split('.')[0] === hit.ticker)
          .map(toRow)
      } catch {
        questradeUp = false
      }
    }

    const candidates = expanded.length
      ? expanded
      : [
          // SEC filers are operating companies by definition; seed the type so
          // they classify as equities rather than falling through to "other".
          withCategory({
            ticker: hit.ticker,
            name: hit.name,
            exchange: 'SEC filer',
            currency: '',
            securityType: 'Stock',
          }),
        ]

    for (const row of candidates) {
      const key = `${row.ticker}|${row.exchange}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
  }

  const shown = keep(rows)

  if (!shown.length && !rows.length && !degraded) {
    degraded = questradeUp
      ? 'No match. Questrade searches by ticker, so try a symbol (e.g. CNQ.TO).'
      : degraded
  }

  return {
    rows: shown.slice(0, 12),
    source: questradeUp ? 'Questrade + SEC' : 'SEC EDGAR',
    degraded,
    filtered: rows.length - shown.length,
  }
}

/**
 * Health check. Deliberately probes symbols/search rather than something
 * cheap like /time, because a valid session is not sufficient: Questrade files
 * the symbols endpoints under the *account* OAuth scope, not the market-data
 * one, so an app registered with market data alone authenticates fine and then
 * fails on every symbol lookup with code 1016. Checking the capability we
 * actually depend on catches that at setup instead of at first search.
 */
export async function checkQuestrade() {
  try {
    await getJson('/api/qt/symbols/search?prefix=SHOP', { ttl: 0 })
    return { ok: true, error: null }
  } catch (err) {
    const message = err instanceof ApiError ? err.message : String(err)
    const scopeProblem = /1016|out of allowed OAuth scopes|403/.test(message)
    return {
      ok: false,
      scopeProblem,
      error: scopeProblem
        ? 'Connected, but the app lacks the OAuth scope for symbol lookup. Enable ' +
          '"Retrieve balances, positions, orders and executions" on the app in App Hub, ' +
          'then generate a new token — Questrade groups the symbols endpoints under that scope.'
        : message,
    }
  }
}
