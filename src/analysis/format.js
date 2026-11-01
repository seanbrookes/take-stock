/** Display formatting. Every formatter renders null/NaN as an em dash. */

const DASH = '—'

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})

export function currency(v) {
  if (!Number.isFinite(v)) return DASH
  const sign = v < 0 ? '-' : ''
  return `${sign}$${compact.format(Math.abs(v))}`
}

export function shares(v) {
  return Number.isFinite(v) ? compact.format(v) : DASH
}

export function perShare(v) {
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : DASH
}

export function percent(v, digits = 1) {
  return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : DASH
}

export function ratio(v, digits = 2) {
  return Number.isFinite(v) ? `${v.toFixed(digits)}x` : DASH
}

export function signedPercent(v, digits = 1) {
  if (!Number.isFinite(v)) return DASH
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`
}

const FORMATTERS = { currency, percent, ratio, shares, perShare, signedPercent }

/** Format by the `format` key declared in the metric catalog. */
export function formatBy(kind, value) {
  return (FORMATTERS[kind] ?? currency)(value)
}

/** '2025-09-27' -> 'Sep 2025' */
export function periodLabel(iso) {
  if (!iso) return DASH
  const [y, m] = iso.split('-')
  const month = new Date(Date.UTC(2000, Number(m) - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  })
  return `${month} ${y}`
}

/** Direction class for coloring a delta, respecting metrics where down is good. */
export function trendClass(value, invertGood = false) {
  if (!Number.isFinite(value) || value === 0) return ''
  const good = invertGood ? value < 0 : value > 0
  return good ? 'pos' : 'neg'
}
