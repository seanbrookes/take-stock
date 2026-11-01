/**
 * Security categories for search filtering.
 *
 * Questrade's own `securityType` is too coarse to filter on: it reports ETFs,
 * REITs, income trusts and operating companies all as "Stock". XIU.TO (iShares
 * S&P/TSX 60) and SHOP.TO are indistinguishable by type, and no field in either
 * the search or detail payload flags a fund. So funds and trusts are identified
 * from the description, which is the only signal available.
 *
 * The heuristics are deliberately conservative in one direction: a fund
 * wrongly shown as an equity is a mild annoyance, whereas hiding a real company
 * because its name happens to contain a fund-ish word would lose a stock you
 * were looking for. Note especially that manager names cannot be matched
 * loosely — "SCOTIA" would swallow Bank of Nova Scotia, "RBC" would catch Royal
 * Bank — so only unambiguous fund vocabulary is used.
 */

export const CATEGORIES = [
  { id: 'equity', label: 'Equities', hint: 'Operating companies' },
  { id: 'etf', label: 'ETFs & funds', hint: 'ETFs, index funds, mutual funds' },
  { id: 'trust', label: 'Trusts & LPs', hint: 'REITs, income trusts, partnerships' },
  { id: 'right', label: 'Rights & warrants', hint: 'Subscription rights, warrants' },
  { id: 'bond', label: 'Bonds', hint: 'Corporate and government debt' },
  { id: 'index', label: 'Indices', hint: 'Reference indices, not tradable' },
  { id: 'other', label: 'Other', hint: 'Structured products, swaps, unclassified' },
]

/** Sensible default: the things you would actually buy as an investor. */
export const DEFAULT_CATEGORIES = ['equity', 'etf', 'trust']

// Explicit fund vocabulary only.
//
// Manager phrases like "ASSET MANAGEMENT", "PORTFOLIOS GROUP" or "INVESTMENT
// MANAGEMENT" look tempting because fund descriptions lead with the manager's
// name — but asset managers are themselves listed operating companies, and
// matching on those hid Brookfield Asset Management (BAM.TO, a TSX 60
// constituent), Sprott, Fiera and CI Financial as if they were funds.
// Every fund in the sample is caught by its fund-name suffix anyway.
const FUND_WORDS = /\b(ETF|ETN|INDEX FUND|MUTUAL FUND|UNIT TRUST|ISHARES|SPDR|FUND|FD)\b/

// Rights and warrants show up with these markers even when typed as Stock.
const RIGHT_WORDS = /\b(WTS?|WARRANTS?|RIGHTS?|RT|SUBSCRIPTION RECEIPTS?)\b/

// Canadian trusts and limited partnerships almost always trade as .UN units.
// Questrade writes limited partnerships inconsistently — "L.P", "L P", "LP" —
// so allow an optional space and optional periods.
const TRUST_WORDS =
  /REAL ESTATE INVESTMENT TRUST|\bREIT\b|\bL\.?\s?P\.?\s*$|LIMITED PARTNERSHIP|INCOME TRUST/

/**
 * @param {{ticker?: string, symbol?: string, name?: string, description?: string, securityType?: string}} row
 * @returns {'equity'|'etf'|'trust'|'right'|'bond'|'index'|'other'}
 */
export function classify(row) {
  const symbol = String(row.ticker ?? row.symbol ?? '').toUpperCase()
  const name = String(row.name ?? row.description ?? '').toUpperCase()
  const type = row.securityType ?? null

  // Questrade's own type is authoritative where it is specific.
  if (type === 'Bond') return 'bond'
  if (type === 'Index') return 'index'
  if (type === 'Option') return 'other'
  if (type === 'Right') return 'right'
  if (type === 'MutualFund') return 'etf'

  // Rights/warrants carry a symbol infix on the TSX (CSU.RT.TO).
  if (/\.(RT|RTA|WT|WS)\b/.test(symbol) || RIGHT_WORDS.test(name)) return 'right'

  // Funds first: "CANADIAN REIT ETF" is a fund holding REITs, not a REIT.
  if (FUND_WORDS.test(name)) return 'etf'

  if (TRUST_WORDS.test(name) || /\.UN\b/.test(symbol)) return 'trust'

  if (type === 'Stock') return 'equity'
  return type ? 'other' : 'other'
}

/** Add a `category` to a listing row. */
export const withCategory = (row) => ({ ...row, category: classify(row) })
