/**
 * Thin fetch wrapper: timeouts, JSON parsing, typed errors, and a TTL cache.
 *
 * The cache is deliberately in-memory only. Filings data changes rarely, but a
 * page reload should still be able to pull fresh numbers without a cache-bust
 * dance, and companyfacts payloads are far too large for localStorage.
 */

export class ApiError extends Error {
  constructor(message, { status = 0, url = '', cause } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.url = url
    this.cause = cause
  }
}

const cache = new Map() // url -> { expires, value }
const inflight = new Map() // url -> Promise, so N components asking at once make 1 request

export function clearCache(prefix) {
  if (!prefix) return cache.clear()
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
}

export function cacheStats() {
  return { entries: cache.size, inflight: inflight.size }
}

/**
 * @param {string} url
 * @param {{ ttl?: number, timeout?: number, signal?: AbortSignal }} [opts]
 */
export async function getJson(url, { ttl = 15 * 60_000, timeout = 30_000, signal } = {}) {
  const hit = cache.get(url)
  if (hit && hit.expires > Date.now()) return hit.value

  if (inflight.has(url)) return inflight.get(url)

  const promise = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout)
    if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason))

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })

      if (!res.ok) {
        // Prefer the server's own explanation over a bare status line. The
        // Questrade proxy reports real causes ("token refresh failed…",
        // "out of allowed OAuth scopes") that are useless if discarded —
        // a raw "503 Service Unavailable" tells nobody what to fix.
        let detail = ''
        try {
          const body = await res.clone().json()
          detail = body?.error ?? body?.message ?? ''
        } catch {
          /* non-JSON body; fall back to the status line */
        }
        // SEC returns 404 for a company that has simply never filed the
        // concept being asked for, which callers treat as "no data" not "error".
        throw new ApiError(detail || `${res.status} ${res.statusText}`, {
          status: res.status,
          url,
        })
      }

      const value = await res.json()
      if (ttl > 0) cache.set(url, { expires: Date.now() + ttl, value })
      return value
    } catch (err) {
      if (err instanceof ApiError) throw err
      const aborted = err?.name === 'AbortError'
      throw new ApiError(aborted ? 'Request timed out' : `Network error: ${err.message}`, {
        url,
        cause: err,
      })
    } finally {
      clearTimeout(timer)
      inflight.delete(url)
    }
  })()

  inflight.set(url, promise)
  return promise
}
