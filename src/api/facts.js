/**
 * Turning raw XBRL into usable time series.
 *
 * Three things make this non-trivial, and all three are handled here:
 *
 * 1. RESTATEMENTS. The same fiscal period is re-reported in later filings.
 *    companyfacts returns every version. We keep the most recently *filed*
 *    value for a given period, which is the company's current best answer.
 *
 * 2. MIXED DURATIONS. Duration facts (revenue, net income) include quarterly,
 *    year-to-date, and annual spans in the same array, distinguishable only by
 *    the gap between `start` and `end`. We filter by span length.
 *
 * 3. INSTANT vs DURATION. Balance-sheet facts have no `start` — they are
 *    point-in-time. They need different period keys and different dedup.
 *
 * 4. YTD REPORTING AND THE MISSING Q4. Cash-flow and many income items are
 *    reported year-to-date in 10-Qs (3mo, then 6mo, then 9mo), so filtering for
 *    ~90-day spans finds only Q1 of each year. And no 10-Q ever contains Q4 —
 *    it exists only as (fiscal year - first nine months). Discrete quarters
 *    therefore have to be *derived* by differencing cumulative figures, which
 *    `buildQuarterlySeries` below does.
 */

const DAY = 86_400_000
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY)
const nextDay = (iso) => new Date(new Date(iso).getTime() + DAY).toISOString().slice(0, 10)

/** Span windows, in days, that count as a given period type. */
const SPANS = {
  annual: [330, 400],
  quarterly: [75, 115],
}

const isQuarterSpan = (n) => n >= 75 && n <= 115

/** Deduplicate duration points by period, keeping the most recently filed. */
function dedupeDurations(raw) {
  const byPeriod = new Map()
  for (const p of raw) {
    if (p.start === undefined) continue
    const key = `${p.start}|${p.end}`
    const prev = byPeriod.get(key)
    if (!prev || p.filed > prev.filed) byPeriod.set(key, p)
  }
  return [...byPeriod.values()]
}

/**
 * Pick the first candidate tag that actually exists in this company's facts.
 * Companies tag the same economic concept differently — Apple uses
 * RevenueFromContractWithCustomerExcludingAssessedTax where others use Revenues —
 * so every metric declares a priority list rather than a single tag.
 *
 * @returns {{tag: string, taxonomy: string, node: object} | null}
 */
export function resolveTag(facts, candidates) {
  if (!facts?.facts) return null
  for (const candidate of candidates) {
    const [taxonomy, tag] = candidate.includes(':') ? candidate.split(':') : ['us-gaap', candidate]
    const node = facts.facts[taxonomy]?.[tag]
    if (node) return { tag, taxonomy, node }
  }
  return null
}

/** Prefer USD, then USD-per-share, then whatever the company actually used. */
function pickUnit(node, preferred) {
  const units = Object.keys(node.units ?? {})
  if (!units.length) return null
  if (preferred && units.includes(preferred)) return preferred
  return units.find((u) => u === 'USD') ?? units.find((u) => u === 'USD/shares') ?? units[0]
}

/**
 * Build a clean, deduplicated, chronologically sorted series for one tag.
 *
 * @param {object} facts       companyfacts payload
 * @param {string[]} candidates tag priority list
 * @param {{period?: 'annual'|'quarterly', unit?: string}} [opts]
 * @returns {{ tag: string, taxonomy: string, unit: string, label: string,
 *             description: string, instant: boolean,
 *             points: Array<{end: string, start?: string, val: number, fy: number,
 *                            fp: string, form: string, filed: string, accn: string}> } | null}
 */
export function buildSeries(
  facts,
  candidates,
  { period = 'annual', unit: wantUnit, select = 'priority' } = {},
) {
  // A tag merely *existing* is not enough. Companies abandon tags: Uber tagged
  // RevenueFromContractWithCustomerExcludingAssessedTax four times in 2018 and
  // never again, while reporting revenue under `Revenues` ever since. Taking
  // the first candidate present would return a dead series from 2018.
  //
  // So build every candidate, then prefer catalog priority *among those still
  // current*, falling back to whichever has the most recent data.
  const built = []
  for (const candidate of candidates) {
    const [taxonomy, tag] = candidate.includes(':') ? candidate.split(':') : ['us-gaap', candidate]
    const node = facts?.facts?.[taxonomy]?.[tag]
    if (!node) continue
    const series = buildForTag(node, tag, taxonomy, period, wantUnit)
    if (series) built.push(series)
  }
  if (!built.length) return null

  const endOf = (s) => s.points.at(-1).end
  const newest = built.reduce((a, b) => (endOf(a) >= endOf(b) ? a : b))
  const cutoff = new Date(new Date(endOf(newest)).getTime() - 400 * DAY).toISOString().slice(0, 10)
  const current = built.filter((s) => endOf(s) >= cutoff)

  if (!current.length) return newest

  // Some companies report both a total and a component under different tags.
  // Enbridge tags Revenues at CAD 65.19B and
  // RevenueFromContractWithCustomerExcludingAssessedTax at CAD 29.33B for the
  // same year — taking the higher-priority tag would halve revenue and roughly
  // double every margin. Where a total is by definition the largest of its
  // candidates, the catalog opts into `select: 'max'`.
  if (select === 'max') {
    return current.reduce((a, b) => (a.points.at(-1).val >= b.points.at(-1).val ? a : b))
  }

  // `built` preserves candidate order, so this is the highest-priority tag
  // that is still being reported.
  return current[0]
}

function buildForTag(node, tag, taxonomy, period, wantUnit) {
  const unit = pickUnit(node, wantUnit)
  if (!unit) return null

  const raw = node.units[unit] ?? []
  // A tag is "instant" if its datapoints carry no start date (balance sheet).
  const instant = raw.length > 0 && raw[0].start === undefined

  // Discrete quarters need derivation from cumulative YTD figures, not filtering.
  if (period === 'quarterly' && !instant) {
    const points = deriveQuarters(raw)
    if (!points.length) return null
    return {
      tag,
      taxonomy,
      unit,
      label: node.label ?? tag,
      description: node.description ?? '',
      instant: false,
      points,
    }
  }

  const [minSpan, maxSpan] = SPANS[period] ?? SPANS.annual

  const byPeriod = new Map()
  for (const p of raw) {
    if (!instant) {
      const span = days(p.start, p.end)
      if (span < minSpan || span > maxSpan) continue
    } else if (period === 'annual') {
      // Balance-sheet values exist at every quarter end; for an annual view
      // keep only fiscal year ends.
      //
      // Select on `fp`, not form. Canadian MJDS filers report annual figures on
      // Form 40-F — and CN Railway files its year-end balance sheet under 6-K —
      // so matching "10-K" drops their balance sheet entirely.
      if (p.fp !== 'FY' && !/^(10-K|20-F|40-F)/.test(p.form)) continue
    }

    // Period identity: instants are keyed by date alone, durations by span.
    const key = instant ? p.end : `${p.start}|${p.end}`
    const prev = byPeriod.get(key)
    // Later filing wins — that is the restatement-aware value.
    if (!prev || p.filed > prev.filed) byPeriod.set(key, p)
  }

  const points = [...byPeriod.values()].sort((a, b) => a.end.localeCompare(b.end))
  if (!points.length) return null

  return {
    tag,
    taxonomy,
    unit,
    label: node.label ?? tag,
    description: node.description ?? '',
    instant,
    points,
  }
}

/**
 * Reconstruct discrete quarters from a mix of quarterly and cumulative facts.
 *
 * Cumulative figures within one fiscal year all share the same `start` date, so
 * grouping by start and differencing consecutive `end`s yields each quarter:
 *
 *   9-month YTD  -  6-month YTD  =  Q3
 *   fiscal year  -  9-month YTD  =  Q4   <- the quarter no 10-Q reports
 *
 * Directly reported quarters win over derived ones where both exist.
 */
export function deriveQuarters(raw) {
  const pts = dedupeDurations(raw)
  if (!pts.length) return []

  const natural = pts.filter((p) => isQuarterSpan(days(p.start, p.end)))

  // Group every point by fiscal-period start so cumulative chains line up.
  const byStart = new Map()
  for (const p of pts) {
    const span = days(p.start, p.end)
    if (span > 400) continue // multi-year spans are not part of any chain
    if (!byStart.has(p.start)) byStart.set(p.start, [])
    byStart.get(p.start).push(p)
  }

  const derived = []
  for (const group of byStart.values()) {
    group.sort((a, b) => a.end.localeCompare(b.end))
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1]
      const curr = group[i]
      const gap = days(prev.end, curr.end)
      if (!isQuarterSpan(gap)) continue
      derived.push({
        ...curr,
        start: nextDay(prev.end),
        val: curr.val - prev.val,
        derived: true,
      })
    }
  }

  const byEnd = new Map()
  for (const p of derived) byEnd.set(p.end, p)
  for (const p of natural) byEnd.set(p.end, p) // as-reported beats computed

  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end))
}

/** Most recent value of a series, or null. */
export const latest = (series) => (series?.points?.length ? series.points.at(-1) : null)

/** Value of a series N periods back from the end. */
export const nthLast = (series, n) => series?.points?.at(-1 - n) ?? null

/**
 * Sum the trailing four quarters — a current figure without waiting for the
 * annual report.
 *
 * Returns null unless those four quarters actually form a contiguous year.
 * Gaps are common (a company skips a tag for a quarter, or an early filing is
 * missing), and silently summing across a gap produces a number that looks
 * authoritative and is simply wrong.
 */
export function trailingTwelveMonths(series, { notBefore } = {}) {
  const pts = series?.points ?? []
  if (pts.length < 4) return null

  const window = pts.slice(-4)
  const span = days(window[0].start, window.at(-1).end)
  if (span < 330 || span > 400) return null

  // A tag can be abandoned mid-life: JPMorgan's quarterly `Revenues` series
  // ends in 2014 but is perfectly contiguous, and would otherwise be presented
  // as the current trailing year.
  if (notBefore && window.at(-1).end < notBefore) return null

  // Each quarter must pick up where the previous one left off (allow a few
  // days of slack for 52/53-week fiscal calendars).
  for (let i = 1; i < window.length; i++) {
    const gap = days(window[i - 1].end, window[i].start)
    if (gap < 0 || gap > 5) return null
  }

  return {
    val: window.reduce((sum, p) => sum + p.val, 0),
    start: window[0].start,
    end: window.at(-1).end,
    periods: window.length,
    derived: window.some((p) => p.derived),
  }
}

/** Compound annual growth rate between the first and last points of a series. */
export function cagr(series, periods) {
  const pts = series?.points ?? []
  const n = Math.min(periods, pts.length - 1)
  if (n < 1) return null
  const first = pts.at(-1 - n).val
  const last = pts.at(-1).val
  // Sign changes make a growth rate meaningless (loss -> profit).
  if (first <= 0 || last <= 0) return null
  return Math.pow(last / first, 1 / n) - 1
}

/** Period-over-period change, as a fraction. */
export function growth(series, back = 1) {
  const pts = series?.points ?? []
  if (pts.length <= back) return null
  const prev = pts.at(-1 - back).val
  const curr = pts.at(-1).val
  if (!prev) return null
  return (curr - prev) / Math.abs(prev)
}

/**
 * The most recent period end anywhere in the payload — the company's true
 * "as of" date, used to tell live tags from abandoned ones.
 */
export function latestFactDate(facts) {
  let max = ''
  for (const tags of Object.values(facts?.facts ?? {})) {
    for (const node of Object.values(tags)) {
      for (const points of Object.values(node.units ?? {})) {
        for (const p of points) if (p.end > max) max = p.end
      }
    }
  }
  return max || null
}

/** An ISO date `days` before the given ISO date. */
export function isoDaysBefore(iso, n) {
  return new Date(new Date(iso).getTime() - n * DAY).toISOString().slice(0, 10)
}

/**
 * Flatten every tag in a companyfacts payload into a searchable list.
 * This backs the raw-data explorer: nothing the SEC has is hidden.
 */
export function listAllTags(facts) {
  const out = []
  for (const [taxonomy, tags] of Object.entries(facts?.facts ?? {})) {
    for (const [tag, node] of Object.entries(tags)) {
      for (const [unit, points] of Object.entries(node.units ?? {})) {
        out.push({
          taxonomy,
          tag,
          unit,
          label: node.label ?? tag,
          description: node.description ?? '',
          count: points.length,
          latest: points.reduce((a, b) => (a && a.end > b.end ? a : b), null),
        })
      }
    }
  }
  return out.sort((a, b) => a.tag.localeCompare(b.tag))
}
