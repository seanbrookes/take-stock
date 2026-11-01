/**
 * THE METRIC CATALOG
 * ------------------
 * This file is the collaboration surface. Every number the app shows is
 * declared here, not computed inside a component — so changing what we track
 * means editing this list, not hunting through views.
 *
 * BASE metrics map directly to XBRL tags. `tags` is a priority list because
 * companies tag the same concept differently; the first one present wins.
 *
 * DERIVED metrics are computed from base metrics. Each returns null rather
 * than a misleading number when its inputs are missing or nonsensical
 * (negative equity, sign flips), so the UI shows "—" instead of a lie.
 *
 * This is a STARTING SET, deliberately conservative and quality-focused.
 * Tell me what to add, drop, or reweight.
 */
import {
  buildSeries,
  latest,
  growth,
  cagr,
  trailingTwelveMonths,
  latestFactDate,
  isoDaysBefore,
} from '../api/facts.js'

// ---------------------------------------------------------------------------
// Base metrics — straight from filings
// ---------------------------------------------------------------------------

export const BASE_METRICS = [
  // --- Income statement ---
  {
    id: 'revenue',
    label: 'Revenue',
    statement: 'income',
    format: 'currency',
    // Total revenue is by definition >= any single revenue component, and
    // filers often tag both. Pick the largest current candidate, not the
    // highest-priority one. See buildSeries `select`.
    select: 'max',
    tags: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
      'SalesRevenueGoodsNet',
    ],
  },
  {
    id: 'costOfRevenue',
    label: 'Cost of revenue',
    statement: 'income',
    format: 'currency',
    tags: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'],
  },
  {
    id: 'grossProfit',
    label: 'Gross profit',
    statement: 'income',
    format: 'currency',
    tags: ['GrossProfit'],
  },
  {
    id: 'researchDevelopment',
    label: 'R&D expense',
    statement: 'income',
    format: 'currency',
    tags: ['ResearchAndDevelopmentExpense'],
  },
  {
    id: 'sgna',
    label: 'SG&A expense',
    statement: 'income',
    format: 'currency',
    tags: [
      'SellingGeneralAndAdministrativeExpense',
      'GeneralAndAdministrativeExpense',
    ],
  },
  {
    id: 'operatingIncome',
    label: 'Operating income',
    statement: 'income',
    format: 'currency',
    tags: ['OperatingIncomeLoss'],
  },
  {
    id: 'pretaxIncome',
    label: 'Pre-tax income',
    statement: 'income',
    format: 'currency',
    tags: [
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
    ],
  },
  {
    id: 'incomeTax',
    label: 'Income tax',
    statement: 'income',
    format: 'currency',
    tags: ['IncomeTaxExpenseBenefit'],
  },
  {
    id: 'netIncome',
    label: 'Net income',
    statement: 'income',
    format: 'currency',
    tags: ['NetIncomeLoss', 'ProfitLoss'],
  },
  {
    id: 'epsDiluted',
    label: 'EPS (diluted)',
    statement: 'income',
    format: 'perShare',
    unit: 'USD/shares',
    tags: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
  },
  {
    id: 'dilutedShares',
    label: 'Diluted shares',
    statement: 'income',
    format: 'shares',
    tags: [
      'WeightedAverageNumberOfDilutedSharesOutstanding',
      'WeightedAverageNumberOfSharesOutstandingBasic',
    ],
  },
  {
    id: 'interestExpense',
    label: 'Interest expense',
    statement: 'income',
    format: 'currency',
    tags: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt'],
  },

  // --- Balance sheet (instant facts) ---
  { id: 'assets', label: 'Total assets', statement: 'balance', format: 'currency', tags: ['Assets'] },
  {
    id: 'liabilities',
    label: 'Total liabilities',
    statement: 'balance',
    format: 'currency',
    tags: ['Liabilities'],
  },
  {
    id: 'equity',
    label: "Shareholders' equity",
    statement: 'balance',
    format: 'currency',
    tags: [
      'StockholdersEquity',
      'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    ],
  },
  {
    id: 'cash',
    label: 'Cash & equivalents',
    statement: 'balance',
    format: 'currency',
    tags: [
      'CashAndCashEquivalentsAtCarryingValue',
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    ],
  },
  {
    id: 'shortTermInvestments',
    label: 'Short-term investments',
    statement: 'balance',
    format: 'currency',
    tags: ['ShortTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent'],
  },
  {
    id: 'currentAssets',
    label: 'Current assets',
    statement: 'balance',
    format: 'currency',
    tags: ['AssetsCurrent'],
  },
  {
    id: 'currentLiabilities',
    label: 'Current liabilities',
    statement: 'balance',
    format: 'currency',
    tags: ['LiabilitiesCurrent'],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    statement: 'balance',
    format: 'currency',
    tags: ['InventoryNet'],
  },
  {
    id: 'longTermDebt',
    label: 'Long-term debt',
    statement: 'balance',
    format: 'currency',
    tags: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  },
  {
    id: 'shortTermDebt',
    label: 'Short-term debt',
    statement: 'balance',
    format: 'currency',
    tags: ['LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings'],
  },
  {
    id: 'goodwill',
    label: 'Goodwill',
    statement: 'balance',
    format: 'currency',
    tags: ['Goodwill'],
  },

  // --- Cash flow ---
  {
    id: 'operatingCashFlow',
    label: 'Operating cash flow',
    statement: 'cashflow',
    format: 'currency',
    tags: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
  },
  {
    id: 'capex',
    label: 'Capital expenditure',
    statement: 'cashflow',
    format: 'currency',
    tags: [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
    ],
  },
  {
    id: 'buybacks',
    label: 'Share buybacks',
    statement: 'cashflow',
    format: 'currency',
    tags: ['PaymentsForRepurchaseOfCommonStock'],
  },
  {
    id: 'dividendsPaid',
    label: 'Dividends paid',
    statement: 'cashflow',
    format: 'currency',
    tags: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'],
  },
  {
    id: 'stockComp',
    label: 'Stock-based comp',
    statement: 'cashflow',
    format: 'currency',
    tags: ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'],
  },
  {
    id: 'depreciation',
    label: 'D&A',
    statement: 'cashflow',
    format: 'currency',
    tags: [
      'DepreciationDepletionAndAmortization',
      'DepreciationAmortizationAndAccretionNet',
      'Depreciation',
    ],
  },
]

export const BASE_BY_ID = Object.fromEntries(BASE_METRICS.map((m) => [m.id, m]))

// ---------------------------------------------------------------------------
// IFRS equivalents
// ---------------------------------------------------------------------------

/**
 * Canadian companies cross-listed in the US file under the Multijurisdictional
 * Disclosure System (Form 40-F), and most report under IFRS — which means their
 * facts live in the `ifrs-full` taxonomy, not `us-gaap`. Without this map,
 * Cameco, Brookfield, RBC, TD, Barrick and friends return nothing at all.
 *
 * A filer uses one taxonomy or the other, never both, so these simply extend
 * each metric's candidate list — there is no conflict to arbitrate.
 *
 * Tags were chosen by frequency across a corpus of 12 Canadian IFRS filers
 * (banks, miners, energy, telecom, insurance) rather than from the taxonomy
 * spec, so they reflect what companies actually tag. The count in each comment
 * is how many of those 12 use it with recent data.
 */
export const IFRS_TAGS = {
  // --- Income statement ---
  // Deliberately NOT including RevenueFromInterest: for a bank, gross interest
  // revenue can exceed "Revenue" (which is net of interest expense), and the
  // `select: 'max'` rule would then pick the wrong figure.
  revenue: ['Revenue', 'RevenueFromContractsWithCustomers', 'RevenueFromSaleOfGoods', 'RevenueFromRenderingOfServices'],
  costOfRevenue: ['CostOfSales', 'CostOfInventoriesRecognisedAsExpenseDuringPeriod'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['ProfitLossFromOperatingActivities'], // only 3/12 tag this
  pretaxIncome: ['ProfitLossBeforeTax'], // 10/12
  incomeTax: ['IncomeTaxExpenseContinuingOperations'], // 12/12
  netIncome: ['ProfitLoss', 'ProfitLossAttributableToOwnersOfParent'], // 12/12
  epsDiluted: ['DilutedEarningsLossPerShare'], // 12/12
  dilutedShares: ['AdjustedWeightedAverageShares', 'WeightedAverageShares'], // 12/12
  interestExpense: ['InterestExpense', 'InterestExpenseOnBorrowings', 'InterestExpenseOnDebtInstrumentsIssued'],

  // --- Balance sheet ---
  assets: ['Assets'], // 12/12
  liabilities: ['Liabilities'], // 10/12
  equity: ['Equity', 'EquityAttributableToOwnersOfParent'], // 12/12
  cash: ['CashAndCashEquivalents', 'Cash'], // 11/12
  currentAssets: ['CurrentAssets'],
  currentLiabilities: ['CurrentLiabilities'],
  inventory: ['Inventories'],
  longTermDebt: ['LongtermBorrowings', 'NoncurrentPortionOfLongtermBorrowings', 'Borrowings'],
  shortTermDebt: [
    'ShorttermBorrowings',
    'CurrentPortionOfLongtermBorrowings',
    'CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings',
  ],
  goodwill: ['Goodwill'],

  // --- Cash flow ---
  // Suncor tags the operating cash flow line as CashFlowsFromUsedInOperations;
  // kept as a fallback so the standard tag still wins where both exist.
  operatingCashFlow: ['CashFlowsFromUsedInOperatingActivities', 'CashFlowsFromUsedInOperations'], // 11/12
  capex: ['PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  buybacks: ['PaymentsToAcquireOrRedeemEntitysShares'],
  dividendsPaid: ['DividendsPaidClassifiedAsFinancingActivities', 'DividendsPaid'],
  stockComp: ['AdjustmentsForSharebasedPayments', 'ExpenseFromSharebasedPaymentTransactionsWithEmployees'],
  depreciation: ['DepreciationAndAmortisationExpense', 'AdjustmentsForDepreciationAndAmortisationExpense'],
}

/** Full candidate list for a metric: US GAAP tags first, then IFRS equivalents. */
export function tagsFor(metric) {
  const ifrs = IFRS_TAGS[metric.id] ?? []
  return [...metric.tags, ...ifrs.map((tag) => `ifrs-full:${tag}`)]
}

// ---------------------------------------------------------------------------
// Derived metrics — the actual analysis
// ---------------------------------------------------------------------------

/** Guarded division: null unless both sides are usable numbers. */
const ratio = (num, den) =>
  Number.isFinite(num) && Number.isFinite(den) && den !== 0 ? num / den : null

export const DERIVED_METRICS = [
  // --- Profitability: is the business actually good? ---
  {
    id: 'grossMargin',
    label: 'Gross margin',
    group: 'Profitability',
    format: 'percent',
    note: 'Pricing power. Stable or rising is the signal; falling means competition.',
    compute: (v) => {
      // Banks report neither gross profit nor cost of revenue. Falling back to
      // `revenue - costOfRevenue` with a null cost silently yields revenue,
      // i.e. a confident 100% gross margin — so require both inputs.
      const gp = Number.isFinite(v.grossProfit)
        ? v.grossProfit
        : Number.isFinite(v.revenue) && Number.isFinite(v.costOfRevenue)
          ? v.revenue - v.costOfRevenue
          : null
      return ratio(gp, v.revenue)
    },
  },
  {
    id: 'operatingMargin',
    label: 'Operating margin',
    group: 'Profitability',
    format: 'percent',
    note: 'Profit from core operations, before financing and tax choices.',
    compute: (v) => ratio(v.operatingIncome, v.revenue),
  },
  {
    id: 'netMargin',
    label: 'Net margin',
    group: 'Profitability',
    format: 'percent',
    compute: (v) => ratio(v.netIncome, v.revenue),
  },
  {
    id: 'fcf',
    label: 'Free cash flow',
    group: 'Profitability',
    format: 'currency',
    note: 'Operating cash flow minus capex — cash actually available to owners.',
    compute: (v) =>
      Number.isFinite(v.operatingCashFlow) && Number.isFinite(v.capex)
        ? v.operatingCashFlow - v.capex
        : null,
  },
  {
    id: 'fcfMargin',
    label: 'FCF margin',
    group: 'Profitability',
    format: 'percent',
    note: 'How much of each revenue dollar becomes free cash. Harder to fake than earnings.',
    compute: (v) =>
      Number.isFinite(v.operatingCashFlow) && Number.isFinite(v.capex)
        ? ratio(v.operatingCashFlow - v.capex, v.revenue)
        : null,
  },
  {
    id: 'cashConversion',
    label: 'Cash conversion',
    group: 'Profitability',
    format: 'percent',
    note: 'OCF / net income. Persistently under 100% suggests earnings quality problems.',
    compute: (v) => ratio(v.operatingCashFlow, v.netIncome),
  },

  // --- Returns on capital ---
  {
    id: 'roe',
    label: 'Return on equity',
    group: 'Returns',
    format: 'percent',
    note: 'Meaningless when equity is negative (buybacks can do this) — shown as — instead.',
    compute: (v) => (v.equity > 0 ? ratio(v.netIncome, v.equity) : null),
  },
  {
    id: 'roa',
    label: 'Return on assets',
    group: 'Returns',
    format: 'percent',
    compute: (v) => ratio(v.netIncome, v.assets),
  },
  {
    id: 'roic',
    label: 'Return on invested capital',
    group: 'Returns',
    format: 'percent',
    note: 'NOPAT / (debt + equity - cash). The cleanest read on capital allocation skill.',
    compute: (v) => {
      const debt = (v.longTermDebt ?? 0) + (v.shortTermDebt ?? 0)
      const investedCapital = debt + (v.equity ?? 0) - (v.cash ?? 0)
      if (!Number.isFinite(v.operatingIncome) || investedCapital <= 0) return null
      // Effective tax rate, falling back to 21% US statutory when unavailable.
      const taxRate =
        v.pretaxIncome > 0 && Number.isFinite(v.incomeTax)
          ? Math.min(Math.max(v.incomeTax / v.pretaxIncome, 0), 0.5)
          : 0.21
      return (v.operatingIncome * (1 - taxRate)) / investedCapital
    },
  },

  // --- Balance sheet health ---
  {
    id: 'currentRatio',
    label: 'Current ratio',
    group: 'Balance sheet',
    format: 'ratio',
    note: 'Short-term solvency. Below 1 means current bills exceed current resources.',
    compute: (v) => ratio(v.currentAssets, v.currentLiabilities),
  },
  {
    id: 'netDebt',
    label: 'Net debt',
    group: 'Balance sheet',
    format: 'currency',
    note: 'Negative is a net cash position.',
    compute: (v) => {
      const debt = (v.longTermDebt ?? 0) + (v.shortTermDebt ?? 0)
      const liquid = (v.cash ?? 0) + (v.shortTermInvestments ?? 0)
      return debt || liquid ? debt - liquid : null
    },
  },
  {
    id: 'ebitda',
    label: 'EBITDA',
    group: 'Balance sheet',
    format: 'currency',
    note: 'Operating income plus depreciation and amortisation.',
    compute: (v) =>
      Number.isFinite(v.operatingIncome) && Number.isFinite(v.depreciation)
        ? v.operatingIncome + v.depreciation
        : null,
  },
  {
    id: 'netDebtToEbitda',
    label: 'Net debt / EBITDA',
    group: 'Balance sheet',
    format: 'ratio',
    note: 'How many years of earnings would clear the debt. Above ~3x is levered; lenders often set covenants here.',
    compute: (v) => {
      const ebitda = Number.isFinite(v.operatingIncome) && Number.isFinite(v.depreciation)
        ? v.operatingIncome + v.depreciation
        : null
      if (!ebitda || ebitda <= 0) return null // meaningless against negative earnings
      const debt = (v.longTermDebt ?? 0) + (v.shortTermDebt ?? 0)
      const liquid = (v.cash ?? 0) + (v.shortTermInvestments ?? 0)
      if (!debt && !liquid) return null
      return (debt - liquid) / ebitda
    },
  },
  {
    id: 'debtToEquity',
    label: 'Debt / equity',
    group: 'Balance sheet',
    format: 'ratio',
    compute: (v) =>
      v.equity > 0 ? ratio((v.longTermDebt ?? 0) + (v.shortTermDebt ?? 0), v.equity) : null,
  },
  {
    id: 'interestCoverage',
    label: 'Interest coverage',
    group: 'Balance sheet',
    format: 'ratio',
    note: 'Operating income / interest expense. Under ~3x starts to constrain the business.',
    compute: (v) => ratio(v.operatingIncome, v.interestExpense),
  },
  {
    id: 'goodwillPctAssets',
    label: 'Goodwill / assets',
    group: 'Balance sheet',
    format: 'percent',
    note: 'High goodwill means the balance sheet leans on past acquisition prices.',
    compute: (v) => ratio(v.goodwill, v.assets),
  },

  // --- Shareholder treatment ---
  {
    id: 'sbcPctRevenue',
    label: 'SBC / revenue',
    group: 'Shareholder',
    format: 'percent',
    note: 'Stock comp is a real cost to you as an owner even though it never touches cash.',
    compute: (v) => ratio(v.stockComp, v.revenue),
  },
  {
    id: 'buybackPctFcf',
    label: 'Buybacks / FCF',
    group: 'Shareholder',
    format: 'percent',
    compute: (v) =>
      Number.isFinite(v.operatingCashFlow) && Number.isFinite(v.capex)
        ? ratio(v.buybacks, v.operatingCashFlow - v.capex)
        : null,
  },
  {
    id: 'payoutRatio',
    label: 'Dividend payout',
    group: 'Shareholder',
    format: 'percent',
    note: 'Dividends / net income. Above 100% is being funded from somewhere else.',
    compute: (v) => (v.netIncome > 0 ? ratio(v.dividendsPaid, v.netIncome) : null),
  },
]

export const DERIVED_BY_ID = Object.fromEntries(DERIVED_METRICS.map((m) => [m.id, m]))

/** Growth rates worth computing for any base metric. */
export const GROWTH_METRICS = [
  { id: 'revenue', label: 'Revenue growth' },
  { id: 'netIncome', label: 'Net income growth' },
  { id: 'epsDiluted', label: 'EPS growth' },
  { id: 'operatingCashFlow', label: 'Operating cash flow growth' },
  { id: 'dilutedShares', label: 'Share count change', invertGood: true },
]

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Compute everything for one company from its raw companyfacts payload.
 *
 * @param {object} facts companyfacts JSON
 * @param {{period?: 'annual'|'quarterly'}} [opts]
 * @returns {{
 *   period: string,
 *   series: Record<string, object|null>,
 *   values: Record<string, number|null>,
 *   derived: Array<{id, label, group, format, note, value}>,
 *   growth: Array<{id, label, yoy, cagr3, cagr5}>,
 *   periods: string[],
 *   missing: string[],
 * }}
 */
export function computeFundamentals(facts, { period = 'annual' } = {}) {
  const series = {}
  const values = {}
  const missing = []

  for (const metric of BASE_METRICS) {
    const s = buildSeries(facts, tagsFor(metric), {
      period,
      unit: metric.unit,
      select: metric.select,
    })
    series[metric.id] = s
    const last = latest(s)
    values[metric.id] = last ? last.val : null
    if (!s) missing.push(metric.id)
  }

  const derived = DERIVED_METRICS.map((m) => ({
    id: m.id,
    label: m.label,
    group: m.group,
    format: m.format,
    note: m.note ?? '',
    value: safeCompute(m, values),
  }))

  const growthRows = GROWTH_METRICS.map((g) => ({
    id: g.id,
    label: g.label,
    invertGood: g.invertGood ?? false,
    yoy: growth(series[g.id]),
    cagr3: cagr(series[g.id], 3),
    cagr5: cagr(series[g.id], 5),
  }))

  // The union of every period end date we have, newest first — the column
  // headers for the financials tables.
  const periodSet = new Set()
  for (const s of Object.values(series)) {
    for (const p of s?.points ?? []) periodSet.add(p.end)
  }
  const periods = [...periodSet].sort().reverse()

  return { period, series, values, derived, growth: growthRows, periods, missing }
}

/** A broken formula on one metric must not take down the whole page. */
function safeCompute(metric, values) {
  try {
    const v = metric.compute(values)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** Trailing-twelve-month view of the headline figures, from quarterly data. */
/**
 * Whether a company's debt figure can be trusted, and as of when.
 *
 * Necessary because the derived ratios sum debt as `(longTermDebt ?? 0) +
 * (shortTermDebt ?? 0)`, which silently turns "no debt tag resolved" into "no
 * debt" — and no debt is the best possible reading. Measured across the 30
 * largest Canadian filers, 8 were affected: Canadian Pacific and Shopify tag no
 * debt concept this mapping knows, and six more last tagged one years ago —
 * Coeur in 2012, Brookfield Infrastructure in 2017, Franco-Nevada in 2019.
 * TC Energy still tags `LongTermDebt`, but at $2.8B against roughly $50B of
 * actual borrowings, because the concept now holds one component.
 *
 * This is the README's "abandoned tags" hazard applied to the balance sheet: a
 * tag existing does not mean it is current, and here the stale value is worse
 * than none, because it grades as excellent.
 *
 * @returns {{asOf: string|null, known: boolean, lagYears: number|null}}
 */
export function assessDebt(facts, { period = 'annual', maxLagYears = 0.6 } = {}) {
  const seriesFor = (id) =>
    buildSeries(facts, tagsFor(BASE_BY_ID[id]), { period, unit: BASE_BY_ID[id].unit })
  const lastEnd = (s) => (s?.points ?? []).map((p) => p.end).sort().at(-1) ?? null

  // The balance-sheet date to judge staleness against: equity is the most
  // reliably tagged instant fact across both taxonomies.
  const anchorEnd = lastEnd(seriesFor('equity'))
  const ltdEnd = lastEnd(seriesFor('longTermDebt'))
  const stdEnd = lastEnd(seriesFor('shortTermDebt'))

  if (!ltdEnd && !stdEnd) return { asOf: null, known: false, lagYears: null }

  const asOf = [ltdEnd, stdEnd].filter(Boolean).sort().at(-1)
  if (!anchorEnd) return { asOf, known: true, lagYears: null }

  const lag = (end) => (new Date(anchorEnd) - new Date(end)) / 31_557_600_000

  /*
   * Judged per series, not on the newest of the two.
   *
   * Long-term borrowings dominate the total for anything but a micro-cap, so a
   * current short-term tag alongside an abandoned long-term one still yields a
   * badly wrong total — and taking the max of the two dates hides exactly that.
   * TC Energy is the case in point: its short-term debt is tagged to the latest
   * year while `LongTermDebt` stopped a year earlier and holds one component.
   *
   * The threshold is well under a year because these are annual figures: a full
   * year of lag means the concept was absent from the most recent annual report,
   * which is a reliable signal even though it cannot catch a tag that is current
   * but holds the wrong thing.
   */
  if (ltdEnd && lag(ltdEnd) > maxLagYears) return { asOf, known: false, lagYears: lag(ltdEnd) }

  const lagYears = lag(asOf)
  return { asOf, known: lagYears <= maxLagYears, lagYears }
}

export function computeTTM(facts) {
  const asOf = latestFactDate(facts)
  // Reject a trailing year that ends more than ~13 months before the company's
  // most recent filed data — that means the tag was abandoned, not that this is
  // the current figure.
  const notBefore = asOf ? isoDaysBefore(asOf, 400) : undefined

  const out = {}
  for (const id of ['revenue', 'netIncome', 'operatingCashFlow', 'capex', 'epsDiluted']) {
    const s = buildSeries(facts, tagsFor(BASE_BY_ID[id]), {
      period: 'quarterly',
      unit: BASE_BY_ID[id].unit,
      select: BASE_BY_ID[id].select,
    })
    out[id] = trailingTwelveMonths(s, { notBefore })
  }
  return out
}
