/**
 * SEC EDGAR client.
 *
 * Free, keyless, official, and the most complete source of US fundamentals
 * there is — every figure a company has tagged in XBRL since ~2009.
 * Fair-use limit is 10 requests/second; the TTL cache in http.js keeps us
 * far below that.
 *
 * All requests go through the Vite dev proxy (see vite.config.js) because
 * SEC requires a declared User-Agent header, which browsers forbid JS from setting.
 */
import { getJson } from './http.js'

const DATA = '/sec-data'
const WWW = '/sec-www'

/** SEC pads CIKs to 10 digits in URLs but returns them unpadded in JSON. */
export const padCik = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0')

let tickerIndex = null

/**
 * The full ticker -> CIK map (~10k companies, ~1MB). Fetched once per session
 * and kept as a flat array so search can scan it directly.
 * @returns {Promise<Array<{cik: string, ticker: string, name: string}>>}
 */
export async function loadTickerIndex() {
  if (tickerIndex) return tickerIndex
  const raw = await getJson(`${WWW}/files/company_tickers.json`, { ttl: 24 * 3600_000 })
  // Shape is an object keyed by row number, not an array.
  tickerIndex = Object.values(raw).map((r) => ({
    cik: padCik(r.cik_str),
    ticker: r.ticker,
    name: r.title,
  }))
  return tickerIndex
}

/**
 * Ticker/name search. Exact ticker matches rank first, then prefix, then name
 * substring — so typing "AAP" surfaces AAP and AAPL before "Advance Auto Parts".
 */
export async function searchCompanies(query, limit = 12) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const index = await loadTickerIndex()

  const scored = []
  for (const row of index) {
    const ticker = row.ticker.toLowerCase()
    const name = row.name.toLowerCase()
    let score
    if (ticker === q) score = 0
    else if (ticker.startsWith(q)) score = 1
    else if (name.startsWith(q)) score = 2
    else if (name.includes(q)) score = 3
    else continue
    scored.push({ ...row, score })
    if (scored.length > 400) break
  }
  return scored.sort((a, b) => a.score - b.score || a.ticker.length - b.ticker.length).slice(0, limit)
}

/** Resolve a ticker symbol to its index row. */
export async function resolveSymbol(symbol) {
  const index = await loadTickerIndex()
  const want = String(symbol).trim().toUpperCase()
  return index.find((r) => r.ticker === want) ?? null
}

/**
 * Company metadata + recent filing history.
 * Includes SIC industry, exchange listings, fiscal year end, former names.
 */
export function fetchSubmissions(cik) {
  return getJson(`${DATA}/submissions/CIK${padCik(cik)}.json`, { ttl: 6 * 3600_000 })
}

/**
 * Every XBRL fact the company has ever filed, keyed by taxonomy -> tag -> unit.
 * Large (1-10MB) but a single request, and it is the backing store for
 * every metric and for the raw-data explorer.
 */
export function fetchCompanyFacts(cik) {
  return getJson(`${DATA}/api/xbrl/companyfacts/CIK${padCik(cik)}.json`, { ttl: 6 * 3600_000 })
}

/**
 * Company facts, or null when the filer has none.
 *
 * Having a CIK does not mean having XBRL data. Unsponsored ADRs are the common
 * case: "PrairieSky Royalty Ltd/ADR" has a submissions record and an OTC
 * ticker, but companyfacts returns 404 because the Canadian company behind it
 * never files financials with the SEC. Same for Dollarama, Metro and Saputo.
 * That is an absence of fundamentals, not an error, and must not take down a
 * page that can still show prices.
 */
export async function fetchCompanyFactsOrNull(cik) {
  try {
    return await fetchCompanyFacts(cik)
  } catch (err) {
    if (err?.status === 404) return null
    throw err
  }
}

/** A single concept's full history — useful for drilling into one tag cheaply. */
export function fetchCompanyConcept(cik, tag, taxonomy = 'us-gaap') {
  return getJson(`${DATA}/api/xbrl/companyconcept/CIK${padCik(cik)}/${taxonomy}/${tag}.json`, {
    ttl: 6 * 3600_000,
  })
}
