/**
 * The local SQLite store, exposed by the dev-server plugin at /api/db.
 *
 * This is what makes screening possible at all: Questrade has no screener
 * endpoint and its symbol search cannot be enumerated, so "every TSX company
 * above $2B" can only be answered from a universe we maintain locally.
 */
import { getJson } from './http.js'

const q = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString()

/**
 * @param {{minCap?: number, maxCap?: number, sector?: string, category?: string,
 *          exchange?: string, sort?: string, dir?: string, limit?: number}} filters
 */
export function fetchUniverse(filters = {}) {
  return getJson(`/api/db/universe?${q(filters)}`, { ttl: 30_000 })
}

export const fetchSectors = () => getJson('/api/db/sectors', { ttl: 30_000 })

export const fetchDbStats = () => getJson('/api/db/stats', { ttl: 0 })

/** Kicks off a background refresh; poll refreshStatus() for progress. */
export const startRefresh = (force = false) =>
  getJson(`/api/db/refresh${force ? '?force=1' : ''}`, { ttl: 0 })

export const refreshStatus = () => getJson('/api/db/refresh-status', { ttl: 0 })

/**
 * Fetch SEC fundamentals for the universe and regrade.
 *
 * Separate from the price refresh because it is a different service with a
 * different rate limit, and far slower: one XBRL payload per company, throttled
 * to SEC's fair-use ceiling.
 */
export const startFundamentals = (opts = {}) =>
  getJson(`/api/db/fundamentals/refresh?${q(opts)}`, { ttl: 0 })

export const fundamentalsStatus = () => getJson('/api/db/fundamentals/status', { ttl: 0 })

/**
 * Cache, budget and staleness for the refresh panel. Reads local state only, so
 * polling it costs nothing.
 */
export const fetchHealth = (opts = {}) => getJson(`/api/db/health?${q(opts)}`, { ttl: 0 })

/** Regrade from stored figures — no network, safe to call after a price change. */
export const recomputeValuation = () => getJson('/api/db/valuation/recompute', { ttl: 0 })

