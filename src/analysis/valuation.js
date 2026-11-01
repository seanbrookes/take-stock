/**
 * Reshape the screener query's flattened valuation columns into one object.
 *
 * `queryUniverse` returns the grade as `value_grade`, `value_score`, … because
 * it is a LEFT JOIN onto a wide row. Both the Screener and the TSX 60 view need
 * the same shape from it, and the TSX 60 view builds its rows from live
 * Questrade calls rather than from the query — so without a shared normalizer
 * the two would drift into showing subtly different things under one label.
 *
 * Returns null when the company has no grade, which is the common case: the
 * cross-source multiples need an SEC filer, and most TSX-only companies are not.
 */
export function valuationOf(row) {
  if (!row?.value_grade) return null
  return {
    grade: row.value_grade,
    score: row.value_score,
    factors: row.value_factors,
    peers: row.value_peers,
    sector: row.sector ?? null,
    pe: row.pe,
    ps: row.ps,
    pb: row.pb,
    pfcf: row.pfcf,
    ev_ebitda: row.ev_ebitda,
  }
}

/**
 * The debt-load grade, same treatment.
 *
 * Returns an object even when there is no grade, because "not graded" here has
 * two very different meanings and the column has to distinguish them: a bank is
 * excluded deliberately, while a TSX-only filer simply has no filings.
 */
export function debtOf(row) {
  if (!row?.debt_grade && !row?.debt_excluded) return null
  return {
    grade: row.debt_grade ?? null,
    score: row.debt_score,
    factors: row.debt_factors,
    peers: row.debt_peers,
    warning: row.debt_warning ?? null,
    excluded: row.debt_excluded ?? null,
    sector: row.sector ?? null,
    debt_to_equity: row.debt_to_equity,
    net_debt_to_ebitda: row.net_debt_to_ebitda,
    interest_coverage: row.interest_coverage,
    current_ratio: row.current_ratio,
  }
}

/** Human sector label; the two sources disagree on spacing and casing. */
export const humanSector = (s) => (s ? s.replace(/([a-z])([A-Z])/g, '$1 $2') : '—')
