import fs from 'node:fs'
import path from 'node:path'
import { classify } from '../src/api/classify.js'
import { namesMatch, trimToSessions, RANGE_SESSIONS } from '../src/api/questrade.js'
import { computeFundamentals, assessDebt } from '../src/analysis/metrics.js'

// SEC requires every automated request to declare a contact address. Mirrors
// the proxy default in vite.config.js; override with SEC_USER_AGENT.
const DEFAULT_SEC_UA = 'take-stock/0.1 (fourfivesixcdn@gmail.com)'

/**
 * node:sqlite is a Node built-in (hence nothing in package.json), but it only
 * exists on 22.5+. Importing db.js eagerly on an older Node kills the whole
 * dev server with `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module:
 * node:sqlite` — which says nothing about Node versions or what to do. So the
 * import is deferred and gated behind this check, and everything except the
 * database keeps working on an older Node.
 */
export function assertSqliteSupport() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major > 22 || (major === 22 && minor >= 5)) return
  throw new Error(
    `The local database needs Node 22.5+ for the built-in node:sqlite, but this is ` +
      `${process.version}. Run "nvm use" in the project directory (.nvmrc pins 22), ` +
      `then restart the dev server.`,
  )
}

/**
 * Questrade API proxy, running inside the Vite dev server.
 *
 * This lives server-side rather than in the browser for two reasons, both
 * mandatory rather than stylistic:
 *
 * 1. REFRESH TOKENS ARE SINGLE-USE AND ROTATE. Every refresh returns a *new*
 *    refresh token and invalidates the old one. If the browser held it and a
 *    reload lost the rotated value, authentication would break permanently and
 *    you would have to generate a new token by hand in Questrade. So the token
 *    is persisted to disk the instant it is issued.
 *
 * 2. IT IS AN ACCOUNT CREDENTIAL. A Questrade token reaches positions,
 *    balances and order history — not just market data. It has no business in
 *    localStorage where any script on the page can read it.
 *
 * Access tokens last 30 minutes; a manually generated token expires after 7
 * days of disuse, so if you leave the app alone for a week you will need to
 * issue a fresh one.
 */

const LOGIN_URL = 'https://login.questrade.com/oauth2/token'
const TOKEN_FILE = '.questrade-token.json'

/**
 * Questrade's published ceilings for market-data calls are 20 requests/second
 * and 15,000/hour. We run deliberately under both: bursts are the thing that
 * trips per-second limits, and a 60-row table fires 60 candle requests at once.
 *
 * Enforcing here rather than in the browser is what makes this reliable — every
 * request funnels through this proxy, so the limit holds no matter how many
 * components, tabs, or reloads are in play.
 */
const RATE = { perSecond: 12, perHour: 13_000 }

/** Upstream calls must fail rather than hang; queued time is not counted. */
const UPSTREAM_TIMEOUT_MS = 25_000

/** Auth must fail fastest of all — everything else queues behind it. */
const TOKEN_TIMEOUT_MS = 15_000

/**
 * Daily candles only change once per trading session, so cached history stays
 * good for half a day. This is what keeps reopening a sector view free.
 */
const CANDLE_TTL_MS = 12 * 3_600_000

/**
 * Chart ranges, each with the candle size that suits it and how long a cached
 * copy stays usable.
 *
 * Granularity is chosen to land near 150-300 points: enough to show the shape
 * of a session without asking Questrade for a series nobody can read at 220px
 * tall. Measured against a real TSX listing, one session returns 153 candles at
 * FiveMinutes and 661 at OneMinute — so one-minute bars are deliberately not
 * offered, being four times the payload drawn into the same few hundred pixels.
 * Questrade includes extended-hours candles, which is why a session runs past
 * the 78 bars a 6.5-hour regular session would give.
 *
 * The TTL is the real difference. Daily bars are settled once the session ends,
 * but an intraday series is stale the moment it is stored, so those ranges keep
 * for minutes rather than half a day. Leaving them on the 12-hour TTL would
 * show this morning's chart until tonight.
 *
 * `days` is calendar days, not sessions, and is padded past the nominal window:
 * a 5-day chart requested on a Tuesday needs to reach back over a weekend to
 * find five sessions, and a 1-day chart before the open has nothing but the
 * previous session to show.
 */
const CANDLE_RANGES = {
  '1d': { days: 4, interval: 'FiveMinutes', ttl: 2 * 60_000, intraday: true },
  '5d': { days: 9, interval: 'FifteenMinutes', ttl: 5 * 60_000, intraday: true },
  '1m': { days: 31, interval: 'OneDay', ttl: CANDLE_TTL_MS },
  '6m': { days: 183, interval: 'OneDay', ttl: CANDLE_TTL_MS },
  '1y': { days: 365, interval: 'OneDay', ttl: CANDLE_TTL_MS },
  '5y': { days: 1826, interval: 'OneWeek', ttl: CANDLE_TTL_MS },
}
const candleRange = (range) => CANDLE_RANGES[range] ?? CANDLE_RANGES['1m']

/** Questrade rejects bare-Z timestamps; it wants a real UTC offset. */
function isoWithOffset(date) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return `${local.toISOString().slice(0, 19)}${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Read and parse a JSON request body; Vite's middleware stack does not. */
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      // A note is text, not an upload; refuse anything absurd.
      if (raw.length > 1_000_000) reject(new Error('Request body too large'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

function createLimiter({ perSecond, perHour }) {
  const minGap = 1000 / perSecond
  let lastStart = 0
  let hourStart = Date.now()
  let hourCount = 0
  let blockedUntil = 0
  let lastRemaining = null
  let lastReset = null
  let lastObservedAt = null

  /**
   * Two queues, not one.
   *
   * A universe refresh enqueues 150+ requests. Under a single FIFO queue every
   * click then waits behind all of them, which at 12 req/s can exceed the
   * browser's timeout — a stock page opened mid-refresh fails, and the failure
   * looks like "symbol not found" rather than "busy". Interactive requests
   * therefore jump ahead of background work; the rate ceiling is unchanged,
   * only the ordering is.
   */
  const foreground = []
  const background = []
  let pumping = false

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (foreground.length || background.length) {
        const now = Date.now()
        if (now - hourStart >= 3_600_000) {
          hourStart = now
          hourCount = 0
        }
        if (hourCount >= perHour) {
          await sleep(Math.min(hourStart + 3_600_000 - Date.now(), 60_000))
          continue
        }
        const wait = Math.max(blockedUntil - Date.now(), lastStart + minGap - Date.now(), 0)
        if (wait > 0) await sleep(wait)

        const next = foreground.shift() ?? background.shift()
        if (!next) break
        lastStart = Date.now()
        hourCount++
        next() // releases the caller; its request runs concurrently
      }
    } finally {
      pumping = false
    }
  }

  return {
    /**
     * Space out request *starts* without serialising the requests themselves —
     * awaiting each call in turn would drop throughput to one-at-a-time.
     */
    schedule(fn, { bulk = false } = {}) {
      return new Promise((resolve, reject) => {
        const release = () => {
          try {
            resolve(fn())
          } catch (err) {
            reject(err)
          }
        }
        ;(bulk ? background : foreground).push(release)
        pump()
      })
    },

    /** Back off when Questrade says to. */
    penalise(untilMs) {
      blockedUntil = Math.max(blockedUntil, untilMs)
    },

    /**
     * Questrade reports remaining budget per response. If it is running low,
     * idle until the window resets rather than pushing into a 429.
     *
     * The figure is also retained rather than just acted on: it is the only
     * authoritative view of the budget — our own hourCount counts requests this
     * process made, and misses anything spent by another session or a previous
     * run of the dev server.
     */
    observe(headers) {
      const remaining = Number(headers.get('x-ratelimit-remaining'))
      const reset = Number(headers.get('x-ratelimit-reset'))
      if (Number.isFinite(remaining)) {
        lastRemaining = remaining
        lastObservedAt = Date.now()
      }
      if (Number.isFinite(reset)) lastReset = reset * 1000
      if (Number.isFinite(remaining) && remaining <= 2 && Number.isFinite(reset)) {
        this.penalise(reset * 1000)
      }
    },

    stats: () => ({
      waiting: foreground.length + background.length,
      foreground: foreground.length,
      background: background.length,
      // What this process has spent in the current rolling hour.
      hourCount,
      hourStart,
      perHour,
      perSecond,
      // What Questrade itself last said, and when.
      remaining: lastRemaining,
      resetAt: lastReset,
      observedAt: lastObservedAt,
      blockedUntil,
    }),
  }
}

export function questradePlugin(env) {
  const tokenPath = path.resolve(process.cwd(), TOKEN_FILE)

  /** @type {{accessToken:string, apiServer:string, refreshToken:string, expiresAt:number}|null} */
  let session = null

  const limiter = createLimiter(RATE)

  const readStoredToken = () => {
    try {
      return JSON.parse(fs.readFileSync(tokenPath, 'utf8')).refreshToken || null
    } catch {
      return null
    }
  }

  const storeToken = (refreshToken) => {
    // Write-then-rename: a reader in another process must never observe a
    // half-written token file.
    const tmp = `${tokenPath}.${process.pid}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({ refreshToken, savedAt: new Date().toISOString(), pid: process.pid }, null, 2),
    )
    fs.renameSync(tmp, tokenPath)
  }

  /**
   * Token exchange, with a timeout.
   *
   * Without one, a token Questrade refuses to answer for hangs indefinitely —
   * and because every request awaits the same single-flight refresh, the whole
   * app stops responding rather than reporting an auth problem. Observed with a
   * spent token: the endpoint answers an *invalid* token with 400 in 0.3s, but
   * never responds at all for that one.
   */
  async function exchange(token) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TOKEN_TIMEOUT_MS)
    try {
      const res = await fetch(
        `${LOGIN_URL}?grant_type=refresh_token&refresh_token=${encodeURIComponent(token)}`,
        { signal: abort.signal },
      )
      return { res, timedOut: false }
    } catch {
      // A timeout is NOT the same as a rejection: Questrade answers an unknown
      // token with 400 in ~0.15s, so a hang means it recognised the token and
      // very likely consumed it while failing to reply. The outcome is unknown.
      return { res: null, timedOut: true }
    } finally {
      clearTimeout(timer)
    }
  }

  /** @type {Promise<object>|null} */
  let refreshInFlight = null

  /**
   * Single-flight the refresh.
   *
   * Refresh tokens are single-use, so concurrent refreshes are self-defeating:
   * the first consumes the token and every other caller gets HTTP 400. The TSX
   * 60 view opening on a cold or expired session fires ~60 requests at once,
   * which turned into a stampede where one request succeeded and the rest
   * failed with 503. All callers now await the same exchange.
   */
  function refreshSession() {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  async function doRefresh() {
    /*
     * Read the file first, not the in-memory session.
     *
     * The token file is shared state: if a second dev server is running (a
     * leftover instance, or a restart overlapping the old one), it rotates the
     * token too, and this process's cached copy is then stale and dead. Since
     * every rotation lands on disk, the file is always the freshest value —
     * treating it as authoritative lets a process that lost the race recover
     * on its own instead of failing with "token refresh failed (400)".
     */
    const stored = readStoredToken() ?? session?.refreshToken
    const seeded = env.QUESTRADE_REFRESH_TOKEN
    if (!stored && !seeded) {
      throw new Error(
        'No Questrade refresh token. In App Hub, open your personal app, click ' +
          '"+ New device", copy the token, and put QUESTRADE_REFRESH_TOKEN=<token> in .env.local',
      )
    }

    let attempt = stored ? await exchange(stored) : { res: null, timedOut: false }

    /*
     * Stop dead on a timeout — do NOT try the next token.
     *
     * Every exchange consumes the token it is given. During a Questrade
     * issuance outage the call hangs *after* consuming it, so falling through
     * to the seeded token would burn that one too, and the next attempt would
     * burn a freshly generated one. One unknown-outcome attempt per refresh is
     * the most that can be risked.
     */
    if (attempt.timedOut) {
      throw new Error(
        'Questrade did not respond to the token exchange within 15s. It answers an ' +
          'unrecognised token in well under a second, so a hang means it accepted yours and ' +
          'failed to reply — the token is probably consumed and the replacement lost. This is ' +
          'a Questrade-side fault, not a configuration problem. Do NOT generate another token ' +
          'yet: it will be consumed the same way. Wait for their service to recover, then ' +
          'generate one and restart.',
      )
    }

    let res = attempt.res

    /*
     * Lost a race? Re-read and try again.
     *
     * Between reading the file and exchanging it, another instance may have
     * rotated the token, making ours single-use-spent. The replacement is
     * already on disk, so one re-read recovers a failure that is otherwise
     * reported as an expired token and sends you to App Hub for nothing.
     */
    if (res && !res.ok) {
      const rotated = readStoredToken()
      if (rotated && rotated !== stored) {
        const retry = await exchange(rotated)
        if (retry.timedOut) throw new Error('Questrade token exchange timed out on retry.')
        res = retry.res
      }
    }

    // A stored token that no longer works must not be a dead end. It happens
    // routinely: the token lapsed, or you created a new authorization (say, to
    // widen OAuth scopes) and pasted it into .env.local — where the stored file
    // would otherwise shadow it forever. Fall back to the seeded token rather
    // than requiring someone to know to delete a hidden file.
    // Only reached when the stored token was *rejected* (a definite answer),
    // never after a timeout — see above.
    if ((!res || !res.ok) && seeded && seeded !== stored) {
      const fallback = await exchange(seeded)
      if (fallback.timedOut) throw new Error('Questrade token exchange timed out.')
      res = fallback.res
    }

    if (!res || !res.ok) {
      const detail = res
        ? `HTTP ${res.status}`
        : 'no response within 15s — Questrade does not answer for a spent token'
      throw new Error(
        `Questrade token refresh failed (${detail}). Refresh tokens are single-use and ` +
          'lapse after 7 days. Generate a new one in App Hub → your app → "+ New device", ' +
          'put it in .env.local as QUESTRADE_REFRESH_TOKEN, and restart the dev server.',
      )
    }

    const body = await res.json()
    // Persist before anything else can fail: losing a rotated token is unrecoverable.
    storeToken(body.refresh_token)

    session = {
      accessToken: body.access_token,
      apiServer: body.api_server, // e.g. https://api01.iq.questrade.com/
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (body.expires_in - 60) * 1000, // refresh a minute early
    }
    return session
  }

  const activeSession = async () =>
    session && session.expiresAt > Date.now() ? session : refreshSession()

  /** Opened lazily so the plugin still loads if the DB is unavailable. */
  let db = null
  let dbApi = null

  async function database() {
    if (db) return { db, api: dbApi }
    assertSqliteSupport()
    // Built from a runtime value on purpose. Vite bundles vite.config.js with
    // esbuild, and esbuild resolves a literal dynamic import at build time —
    // turning it back into an eager import and reintroducing the crash this
    // deferral exists to prevent.
    const dbUrl = new URL('./db.js', import.meta.url).href
    dbApi = await import(/* @vite-ignore */ dbUrl)
    db = dbApi.openDb(process.cwd())
    return { db, api: dbApi }
  }

  /* ---------------------------------------------------------------------
   * Fundamentals backfill
   *
   * Fetches each interlisted company's XBRL once, computes the derived
   * metrics, stores the numbers and discards the filing. SEC's fair-use limit
   * is 10 requests/second and it requires a contact User-Agent; this runs well
   * under that and is entirely separate from the Questrade limiter, which
   * governs a different service.
   *
   * Called directly rather than through the /sec-* proxies: those exist so the
   * *browser* can reach SEC, and this already runs server-side.
   * ------------------------------------------------------------------- */
  let fundState = { running: false, done: 0, total: 0, matched: 0, skipped: 0, error: null }
  let secIndex = null

  const SEC_UA = env.SEC_USER_AGENT || DEFAULT_SEC_UA
  const secGet = async (url, onBytes) => {
    const res = await fetch(url, { headers: { 'User-Agent': SEC_UA, 'Accept-Encoding': 'gzip' } })
    if (!res.ok) return null
    // Read as text to measure it. The payload is parsed either way, so this
    // costs one extra string rather than an extra pass over the network.
    const text = await res.text()
    onBytes?.(text.length)
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  async function loadSecIndex() {
    if (secIndex) return secIndex
    const raw = await secGet('https://www.sec.gov/files/company_tickers.json')
    secIndex = Object.values(raw ?? {})
      .map((r) => ({ cik: String(r.cik_str).padStart(10, '0'), ticker: r.ticker, name: r.title }))
      // Unsponsored ADR stubs carry a ticker but file nothing.
      .filter((r) => !/\/ADR\b/i.test(r.name) && !/\bUNSPON(SORED)?\b/i.test(r.name))
    return secIndex
  }

  /**
   * Daily reference rates from the Bank of Canada — free, keyless, official,
   * and Canadian, which is the same reason SEC EDGAR is used for filings.
   *
   * Only the pairs Canadian filers actually report in. A failure here is not
   * fatal: grading falls back to suppressing mismatched-currency ratios, which
   * is what it did before rates existed.
   */
  async function refreshFxRates() {
    const { db: store, api } = await database()
    const series = { USD: 'FXUSDCAD', EUR: 'FXEURCAD' }
    const rates = {}
    for (const [code, id] of Object.entries(series)) {
      try {
        const res = await fetch(
          `https://www.bankofcanada.ca/valet/observations/${id}/json?recent=1`,
        )
        if (!res.ok) continue
        const obs = (await res.json()).observations?.[0]
        const v = Number(obs?.[id]?.v)
        if (Number.isFinite(v) && v > 0) {
          rates[code] = v
          rates[`${code}_date`] = obs.d
        }
      } catch {
        // Leave this pair out; the converter simply returns null for it.
      }
    }
    if (Object.keys(rates).length) api.saveFxRates(store, rates)
    return api.getFxRates(store)
  }

  async function refreshFundamentals({ minCap = 0, force = false } = {}) {
    if (fundState.running) return fundState
    const { db: store, api } = await database()
    const targets = force
      ? store.prepare('SELECT symbol, listed_name AS name FROM universe').all()
      : api.staleFundamentals(store, { minCap })

    fundState = {
      running: true,
      done: 0,
      total: targets.length,
      matched: 0,
      skipped: 0,
      // This sweep's cost is bandwidth, not request count: SEC's rate limit is
      // never the binding constraint, but the payloads run 2-8MB each.
      bytes: 0,
      startedAt: Date.now(),
      error: null,
    }

    ;(async () => {
      try {
        // Rates first: without them every cross-source ratio is suppressed and
        // the sweep's whole output would grade on P/E alone.
        await refreshFxRates()
        const index = await loadSecIndex()
        for (const target of targets) {
          fundState.done++
          try {
            const root = target.symbol.replace(/\.(TO|VN)$/, '').split('.')[0].toUpperCase()
            const filer =
              index.find((r) => r.ticker === root && namesMatch(r.name, target.name ?? root)) ??
              index.find((r) => namesMatch(r.name, target.name ?? ''))
            if (!filer) {
              fundState.skipped++
              continue
            }

            const facts = await secGet(
              `https://data.sec.gov/api/xbrl/companyfacts/CIK${filer.cik}.json`,
              (n) => (fundState.bytes += n),
            )
            if (!facts?.facts) {
              fundState.skipped++
              continue
            }

            const f = computeFundamentals(facts, { period: 'annual' })
            const d = (id) => f.derived.find((x) => x.id === id)?.value ?? null

            /*
             * Suppress every debt-derived figure when the debt tag is absent or
             * years out of date. The derived metrics sum debt as
             * `(longTermDebt ?? 0) + (shortTermDebt ?? 0)`, so an unresolved tag
             * reads as zero debt — which is the *best* possible grade. Canadian
             * Pacific tags no debt concept this mapping knows and was grading A
             * on roughly $20B of borrowings.
             *
             * Net debt goes too, which also removes the affected companies from
             * EV/EBITDA in the value grade: an enterprise value built on unknown
             * debt is equally wrong.
             */
            const debt = assessDebt(facts, { period: 'annual' })
            const ifKnown = (v) => (debt.known ? v : null)

            api.saveFundamentals(store, {
              symbol: target.symbol,
              cik: filer.cik,
              entityName: facts.entityName,
              asOf: f.periods[0] ?? null,
              // The unit the filing reports in. Revenue first, equity as the
              // fallback for financials that tag no top-line revenue at all.
              currency: f.series?.revenue?.unit ?? f.series?.equity?.unit ?? null,
              debtToEquity: ifKnown(d('debtToEquity')),
              netDebtToEbitda: ifKnown(d('netDebtToEbitda')),
              // Interest coverage and the current ratio do not use the debt
              // tags at all, so they survive an unknown debt figure.
              interestCoverage: d('interestCoverage'),
              currentRatio: d('currentRatio'),
              ebitda: d('ebitda'),
              netDebt: ifKnown(d('netDebt')),
              equity: f.values.equity ?? null,
              debtAsOf: debt.asOf,
              roic: d('roic'),
              grossMargin: d('grossMargin'),
              operatingMargin: d('operatingMargin'),
              netMargin: d('netMargin'),
              fcf: d('fcf'),
              revenue: f.values.revenue,
              revenueGrowth: f.growth.find((g) => g.id === 'revenue')?.yoy ?? null,
            })
            fundState.matched++
          } catch {
            fundState.skipped++ // one bad filing must not stop the sweep
          }
          // ~7 requests/second, comfortably inside SEC's 10/s fair use.
          await sleep(140)
        }
        // Grades are a pure function of the stored numbers, so they are rebuilt
        // once at the end rather than after every company. Debt is rebuilt only
        // here — unlike valuation it does not depend on market cap, so a price
        // refresh cannot invalidate it.
        api.computeValuation(store)
        api.computeDebt(store)
      } catch (err) {
        fundState.error = err.message
      } finally {
        fundState.running = false
        try {
          api.saveRunSummary(store, 'fundamentals', {
            targets: fundState.total,
            matched: fundState.matched,
            skipped: fundState.skipped,
            bytes: fundState.bytes,
            ms: Date.now() - fundState.startedAt,
            error: fundState.error,
          })
        } catch {
          // Reporting must never be the thing that fails a sweep.
        }
      }
    })()

    return fundState
  }

  /** Guards against two refreshes running at once. */
  let refreshState = { running: false, done: 0, total: 0, startedAt: null, error: null }

  /**
   * Price every stale symbol in the universe.
   *
   * Runs in the background and reports progress, because a full TSX import is
   * ~1,700 symbols — roughly 43 batched requests, which the limiter spreads
   * over a few seconds rather than firing at once.
   */
  async function refreshUniverse(force) {
    if (refreshState.running) return refreshState
    const { db: store, api } = await database()
    const symbols = force
      ? store.prepare('SELECT symbol FROM universe').all().map((r) => r.symbol)
      : api.staleUniverse(store)

    refreshState = {
      running: true,
      done: 0,
      total: symbols.length,
      relabelled: 0,
      unresolved: 0,
      requests: 0,
      startedAt: Date.now(),
      error: null,
    }

    ;(async () => {
      try {
        const session = await activeSession()
        // Bulk: the refresh must never starve a click on a stock page.
        // Counted so the panel can report what the run actually cost, rather
        // than the row count — which is ~40x higher, since symbols are batched.
        const call = (url) => {
          refreshState.requests++
          return limiter.schedule(
            () => fetch(url, { headers: { Authorization: `Bearer ${session.accessToken}` } }),
            { bulk: true },
          )
        }
        const relabel = store.prepare('UPDATE universe SET symbol = ? WHERE symbol = ?')
        const saveOne = (s) =>
          api.saveSymbols(store, [s], (x) =>
            classify({ ticker: x.symbol, name: x.description, securityType: x.securityType }),
          )

        for (let i = 0; i < symbols.length; i += 40) {
          const chunk = symbols.slice(i, i + 40)
          const res = await call(
            `${session.apiServer}v1/symbols?names=${encodeURIComponent(chunk.join(','))}`,
          )

          let returned = []
          if (res.ok) {
            const body = await res.json()
            returned = body.symbols ?? []
            api.saveSymbols(store, returned, (s) =>
              classify({ ticker: s.symbol, name: s.description, securityType: s.securityType }),
            )
          }

          /*
           * TMX reports the *root* ticker, which is often not the tradable
           * symbol: Rogers files as RCI but trades as RCI.B, Teck as TECK.B,
           * CGI as GIB.A, Brookfield Infrastructure as BIP.UN. Left alone,
           * several TSX 60 constituents would silently never resolve.
           *
           * So anything the batch did not return gets one search on its root,
           * and the universe row is relabelled to the real trading symbol.
           */
          const got = new Set(returned.map((s) => s.symbol))
          for (const wanted of chunk.filter((c) => !got.has(c))) {
            const suffix = wanted.endsWith('.VN') ? '.VN' : '.TO'
            const rootTicker = wanted.replace(/\.(TO|VN)$/, '')
            const search = await call(
              `${session.apiServer}v1/symbols/search?prefix=${encodeURIComponent(rootTicker)}`,
            )
            if (!search.ok) {
              refreshState.unresolved++
              continue
            }
            const candidates = ((await search.json()).symbols ?? []).filter(
              (s) => s.symbol.startsWith(`${rootTicker}.`) && s.symbol.endsWith(suffix),
            )
            if (!candidates.length) {
              refreshState.unresolved++
              continue
            }

            /*
             * Pick by market cap, not by symbol shape.
             *
             * A root often has several classes and only one is the listing you
             * would actually buy. Choosing the shortest or alphabetically first
             * symbol picks the thin voting class every time: RCI.A instead of
             * RCI.B, TECK.A instead of TECK.B, BIP.W instead of BIP.UN. Search
             * results carry no market cap, so the candidates are priced first
             * and the largest wins.
             */
            let match = candidates[0]
            if (candidates.length > 1) {
              const detail = await call(
                `${session.apiServer}v1/symbols?names=${encodeURIComponent(
                  candidates.slice(0, 8).map((c) => c.symbol).join(','),
                )}`,
              )
              if (detail.ok) {
                const priced = (await detail.json()).symbols ?? []
                match =
                  priced
                    .filter((s) => Number.isFinite(s.marketCap) && s.marketCap > 0)
                    .sort((a, b) => b.marketCap - a.marketCap)[0] ?? match
              }
            }
            try {
              relabel.run(match.symbol, wanted)
            } catch {
              // The real symbol is already in the universe under its own row;
              // drop the duplicate root entry rather than fail the refresh.
              store.prepare('DELETE FROM universe WHERE symbol = ?').run(wanted)
            }
            saveOne(match)
            refreshState.relabelled++
          }

          refreshState.done = Math.min(i + 40, symbols.length)
        }

        /*
         * Cross-check against TMX's market cap.
         *
         * A root ticker can resolve to a real but wrong listing: CTC.TO exists
         * and prices at $0.7B, while TMX reports Canadian Tire at $10.3B —
         * the listing people actually trade is CTC.A.TO. Because the batch
         * succeeded, the relabelling above never fired. A large divergence
         * between the two sources is the signal that we picked a thin class.
         */
        const suspect = store
          .prepare(
            `SELECT u.symbol, u.tmx_market_cap, s.market_cap
             FROM universe u JOIN symbols s ON s.symbol = u.symbol
             WHERE u.tmx_market_cap > 0 AND s.market_cap > 0
               AND (u.tmx_market_cap / s.market_cap > 3)`,
          )
          .all()

        for (const row of suspect) {
          const suffix = row.symbol.endsWith('.VN') ? '.VN' : '.TO'
          const rootTicker = row.symbol.replace(/\.(TO|VN)$/, '').split('.')[0]
          const search = await call(
            `${session.apiServer}v1/symbols/search?prefix=${encodeURIComponent(rootTicker)}`,
          )
          if (!search.ok) continue
          const candidates = ((await search.json()).symbols ?? []).filter(
            (s) => s.symbol.startsWith(`${rootTicker}.`) && s.symbol.endsWith(suffix),
          )
          if (!candidates.length) continue

          const detail = await call(
            `${session.apiServer}v1/symbols?names=${encodeURIComponent(
              candidates.slice(0, 8).map((c) => c.symbol).join(','),
            )}`,
          )
          if (!detail.ok) continue
          const best = ((await detail.json()).symbols ?? [])
            .filter((s) => Number.isFinite(s.marketCap) && s.marketCap > 0)
            .sort((a, b) => b.marketCap - a.marketCap)[0]

          // Only switch if the alternative genuinely matches TMX better.
          if (!best || best.symbol === row.symbol) continue
          const wasOff = Math.abs(Math.log(row.tmx_market_cap / row.market_cap))
          const nowOff = Math.abs(Math.log(row.tmx_market_cap / best.marketCap))
          if (nowOff >= wasOff) continue

          try {
            relabel.run(best.symbol, row.symbol)
          } catch {
            store.prepare('DELETE FROM universe WHERE symbol = ?').run(row.symbol)
          }
          saveOne(best)
          refreshState.reclassed = (refreshState.reclassed ?? 0) + 1
        }

        // Every multiple has market cap in the numerator, so new prices mean
        // stale grades. Regrading is local arithmetic over ~2,000 rows.
        try {
          api.computeValuation(store)
        } catch (err) {
          // A grading failure must not present as a failed price refresh —
          // the prices did land.
          refreshState.gradeError = err.message
        }
      } catch (err) {
        refreshState.error = err.message
      } finally {
        refreshState.running = false
        try {
          api.saveRunSummary(store, 'prices', {
            symbols: refreshState.total,
            requests: refreshState.requests,
            relabelled: refreshState.relabelled,
            unresolved: refreshState.unresolved,
            ms: Date.now() - refreshState.startedAt,
            error: refreshState.error,
          })
        } catch {
          // Reporting must never be the thing that fails a refresh.
        }
      }
    })()

    return refreshState
  }

  /**
   * One-line health report at startup, so a missing token or an unusable
   * database is visible immediately rather than on the first failed request.
   * Deliberately makes no API call — that would add latency and spend rate
   * budget on every restart.
   */
  async function logHealth(logger) {
    try {
      const { db: store, api } = await database()
      const s = api.dbStats(store)
      const file = path.resolve(process.cwd(), 'data', 'take-stock.db')
      const size = fs.existsSync(file) ? (fs.statSync(file).size / 1e6).toFixed(1) : '0.0'
      const n = (v) => v.toLocaleString('en-US')
      logger.info(
        `  \x1b[32m➜\x1b[0m  db:        \x1b[32mready\x1b[0m  ${n(s.universe)} listings ` +
          `(${n(s.priced)} priced) · ${n(s.candles)} candles · ${n(s.secFilers)} SEC filers · ${size} MB`,
      )
      if (s.universe === 0) {
        logger.info(
          `  \x1b[33m➜\x1b[0m  db:        empty — import a TMX export: ` +
            `\x1b[1mnpm run import-tmx -- <file.csv>\x1b[0m`,
        )
      }
    } catch (err) {
      logger.warn(`  \x1b[33m➜\x1b[0m  db:        \x1b[33munavailable\x1b[0m — ${err.message}`)
    }

    /*
     * Two dev servers sharing one rotating single-use token will fight over it:
     * whichever refreshes second gets HTTP 400, which surfaces as "token
     * expired, generate a new one" when nothing is actually wrong with it.
     * Worth flagging at startup — it is invisible otherwise.
     */
    const lockPath = path.resolve(process.cwd(), 'data', '.dev-server.pid')
    try {
      const prior = Number(fs.readFileSync(lockPath, 'utf8'))
      if (prior && prior !== process.pid) {
        // signal 0 tests for existence without touching the process
        process.kill(prior, 0)
        logger.warn(
          `  \x1b[33m➜\x1b[0m  warning:   another dev server is running (pid ${prior}). ` +
            `They share one rotating Questrade token and will invalidate each other — stop one.`,
        )
      }
    } catch {
      /* no lock file, or the recorded process is gone — both fine */
    }
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true })
      fs.writeFileSync(lockPath, String(process.pid))
    } catch {
      /* best effort */
    }

    const hasToken = Boolean(readStoredToken() || env.QUESTRADE_REFRESH_TOKEN)
    logger.info(
      hasToken
        ? `  \x1b[32m➜\x1b[0m  questrade: \x1b[32mtoken present\x1b[0m  (validated on first request)`
        : `  \x1b[33m➜\x1b[0m  questrade: \x1b[33mno token\x1b[0m — prices and TSX search disabled; see Settings`,
    )
  }

  return {
    name: 'questrade-proxy',
    configureServer(server) {
      // After 'listening' so these land under Vite's own banner.
      server.httpServer?.once('listening', () => {
        setTimeout(() => logHealth(server.config.logger), 0)
      })

      // --- local database API ------------------------------------------
      server.middlewares.use('/api/db', async (req, res) => {
        const json = (status, payload) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }
        try {
          const url = new URL(req.url, 'http://localhost')
          const params = Object.fromEntries(url.searchParams)
          const { db: store, api } = await database()

          // --- research journal: notes, reminders, groups ---
          if (url.pathname.startsWith('/notes')) {
            if (req.method === 'POST') return json(200, api.addNote(store, await body(req)))
            if (req.method === 'PATCH') {
              const patch = await body(req)
              const updated = api.updateNote(store, Number(patch.id), patch)
              return updated ? json(200, updated) : json(404, { error: 'No such note' })
            }
            if (req.method === 'DELETE') {
              api.deleteNote(store, Number(params.id))
              return json(200, { ok: true })
            }
            if (params.symbol) return json(200, { notes: api.listNotes(store, params.symbol) })
            if (url.pathname === '/notes/counts') return json(200, { counts: api.noteCounts(store) })
            return json(200, { notes: api.listAllNotes(store, params) })
          }

          if (url.pathname.startsWith('/reminders')) {
            if (req.method === 'POST') return json(200, api.addReminder(store, await body(req)))
            if (req.method === 'PATCH') {
              api.completeReminder(store, Number((await body(req)).id))
              return json(200, { ok: true })
            }
            if (req.method === 'DELETE') {
              api.deleteReminder(store, Number(params.id))
              return json(200, { ok: true })
            }
            if (url.pathname === '/reminders/due') return json(200, { due: api.dueReminders(store) })
            return json(200, {
              reminders: api.listReminders(store, {
                includeDone: params.includeDone === '1',
                symbol: params.symbol ?? null,
              }),
            })
          }

          if (url.pathname.startsWith('/groups')) {
            if (req.method === 'POST') {
              const payload = await body(req)
              if (payload.groupId && payload.symbol) {
                api.addToGroup(store, Number(payload.groupId), payload.symbol)
                return json(200, { ok: true })
              }
              if (!payload.name?.trim()) return json(400, { error: 'Group name required' })
              try {
                return json(200, api.createGroup(store, payload))
              } catch {
                // Names are one namespace across lists and tags, so a clash may
                // be with the *other* kind — which is invisible from wherever
                // the user is typing. Say which, or the message is unusable.
                const clash = store
                  .prepare(
                    "SELECT id, COALESCE(kind,'list') AS kind FROM watch_groups WHERE name = ?",
                  )
                  .get(payload.name)
                return json(409, {
                  error: clash
                    ? `"${payload.name}" already exists as a ${clash.kind}`
                    : `"${payload.name}" already exists`,
                  existingId: clash?.id ?? null,
                  existingKind: clash?.kind ?? null,
                })
              }
            }
            if (req.method === 'DELETE') {
              if (params.symbol) api.removeFromGroup(store, Number(params.id), params.symbol)
              else api.deleteGroup(store, Number(params.id))
              return json(200, { ok: true })
            }
            if (url.pathname === '/groups/members') {
              return json(200, { members: api.groupsBySymbol(store) })
            }
            return json(200, { groups: api.listGroups(store) })
          }

          // Local reads only — the panel that reports on API cost must not be
          // a source of it.
          if (url.pathname === '/health') {
            return json(200, {
              ...api.healthStats(store, {
                candleRange: params.range || '1m',
                minCap: Number(params.minCap) || 0,
              }),
              questrade: limiter.stats(),
              running: { prices: refreshState.running, fundamentals: fundState.running },
            })
          }
          if (url.pathname === '/fundamentals/refresh') {
            return json(202, await refreshFundamentals({
              minCap: Number(params.minCap) || 0,
              force: params.force === '1',
            }))
          }
          if (url.pathname === '/fundamentals/status') {
            return json(200, {
              ...fundState,
              coverage: api.fundamentalsCoverage(store),
              valuation: api.valuationCoverage(store),
            })
          }
          // Regrading is cheap (no network) and depends on market cap, so it is
          // exposed on its own for a rerun after a price refresh.
          if (url.pathname === '/valuation/recompute') {
            await refreshFxRates()
            return json(200, {
              ...api.computeValuation(store),
              debt: api.computeDebt(store),
              fx: api.getFxRates(store),
            })
          }
          if (url.pathname === '/annotations') return json(200, api.annotations(store))
          if (url.pathname === '/stats') return json(200, api.dbStats(store))
          if (url.pathname === '/sectors') return json(200, { sectors: api.sectorSummary(store) })
          if (url.pathname === '/universe') {
            return json(200, { rows: api.queryUniverse(store, params), stats: api.dbStats(store) })
          }
          /*
           * Cached price history.
           *
           * Serves from SQLite when fresh and only calls Questrade otherwise,
           * so reopening a sector view costs nothing. Requests are marked bulk
           * so a lazy-loading table of 200 sparklines cannot delay a click.
           */
          if (url.pathname === '/candles') {
            const symbolId = Number(params.symbolId)
            const range = params.range ?? '1m'
            const force = params.force === '1'
            if (!symbolId) return json(400, { error: 'symbolId required' })

            const spec = candleRange(range)
            // Intraday rows are keyed by a full timestamp rather than a date, so
            // the cutoff has to be one too or a string compare would drop the
            // current session's candles.
            const cutoff = new Date(Date.now() - spec.days * 86_400_000)
            const since = spec.intraday ? cutoff.toISOString() : cutoff.toISOString().slice(0, 10)

            const served = (rows) => trimToSessions(rows, RANGE_SESSIONS[range])

            if (!force && api.candlesFresh(store, symbolId, range, spec.ttl)) {
              return json(200, {
                candles: served(api.getCandles(store, symbolId, range, since)),
                cached: true,
              })
            }

            let session = await activeSession()
            const end = new Date()
            const start = new Date(end.getTime() - spec.days * 86_400_000)
            const qs = new URLSearchParams({
              startTime: isoWithOffset(start),
              endTime: isoWithOffset(end),
              interval: spec.interval,
            })
            const fetchCandles = (sess) =>
              limiter.schedule(
                () =>
                  fetch(`${sess.apiServer}v1/markets/candles/${symbolId}?${qs}`, {
                    headers: { Authorization: `Bearer ${sess.accessToken}` },
                  }),
                { bulk: true },
              )

            let res = await fetchCandles(session)
            // Same 401 recovery the /api/qt proxy has. Without it, an access
            // token invalidated before our clock expected it returned a bare
            // 401 here and the chart simply never appeared.
            if (res.status === 401) {
              session = await refreshSession()
              res = await fetchCandles(session)
            }
            if (!res.ok) {
              return json(res.status, {
                error:
                  res.status === 401
                    ? 'Questrade rejected the session (401). The refresh token may be spent — see Settings.'
                    : `Questrade ${res.status}`,
              })
            }

            const candles = (await res.json()).candles ?? []
            api.saveCandles(store, symbolId, range, candles)
            api.markCandleFetch(store, symbolId, range, candles.length)
            // Return what the window covers rather than the raw response: on an
            // intraday range the stored table still holds older candles from
            // previous fetches, and getCandles applies the same cutoff a cache
            // hit would, so both paths return the same thing.
            return json(200, {
              candles: served(api.getCandles(store, symbolId, range, since)),
              cached: false,
            })
          }

          if (url.pathname === '/coverage') {
            return json(200, api.candleCoverage(store, params.range ?? '1m'))
          }

          if (url.pathname === '/refresh') {
            const state = await refreshUniverse(params.force === '1')
            return json(202, state)
          }
          if (url.pathname === '/refresh-status') return json(200, refreshState)
          return json(404, { error: `Unknown db route ${url.pathname}` })
        } catch (err) {
          json(500, { error: err.message })
        }
      })

      server.middlewares.use('/api/qt', async (req, res) => {
        const send = (status, payload) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }

        try {
          let s = await activeSession()
          const call = (sess) =>
            limiter.schedule(async () => {
              // Without a timeout a slow upstream call hangs forever, holding
              // the connection open until the browser gives up with no
              // explanation. Long-range candle requests are the usual culprit.
              const abort = new AbortController()
              const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS)
              try {
                return await fetch(`${sess.apiServer}v1${req.url}`, {
                  headers: { Authorization: `Bearer ${sess.accessToken}` },
                  signal: abort.signal,
                })
              } finally {
                clearTimeout(timer)
              }
            })

          let upstream = await call(s)

          // A cached access token can be invalidated server-side; one retry.
          if (upstream.status === 401) {
            s = await refreshSession()
            upstream = await call(s)
          }

          // Throttled anyway: honour Retry-After / reset, back off, retry once.
          if (upstream.status === 429) {
            const retryAfter = Number(upstream.headers.get('retry-after'))
            const reset = Number(upstream.headers.get('x-ratelimit-reset'))
            const until = Number.isFinite(retryAfter)
              ? Date.now() + retryAfter * 1000
              : Number.isFinite(reset)
                ? reset * 1000
                : Date.now() + 5000
            limiter.penalise(until)
            server.config.logger.warn(
              `[questrade] rate limited, backing off ${Math.ceil((until - Date.now()) / 1000)}s`,
            )
            upstream = await call(s)
          }

          limiter.observe(upstream.headers)

          res.statusCode = upstream.status
          res.setHeader('Content-Type', 'application/json')
          // Pass the budget through so the app can show it.
          for (const h of ['x-ratelimit-remaining', 'x-ratelimit-reset']) {
            const v = upstream.headers.get(h)
            if (v) res.setHeader(h, v)
          }
          res.setHeader('x-proxy-queue', String(limiter.stats().waiting))
          res.end(await upstream.text())
        } catch (err) {
          send(503, { error: err.message, configured: false })
        }
      })
    },
  }
}
