import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Local SQLite store.
 *
 * Two jobs, both of which the previous in-memory cache did badly:
 *
 * 1. SURVIVE RESTARTS. SEC companyfacts payloads are 2-8MB each, so browsing
 *    thirty companies re-downloaded well over 100MB on every page reload.
 * 2. MAKE THE UNIVERSE QUERYABLE. Questrade has no screener endpoint and its
 *    symbol search cannot be enumerated, so screening by market cap or sector
 *    is only possible against a local table we maintain ourselves.
 *
 * Uses node:sqlite (Node 22.5+), which is still flagged experimental — hence
 * the pinned engines field and .nvmrc.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS symbols (
  symbol         TEXT PRIMARY KEY,
  symbol_id      INTEGER,
  name           TEXT,
  exchange       TEXT,
  currency       TEXT,
  security_type  TEXT,
  category       TEXT,
  sector         TEXT,
  market_cap     REAL,
  pe             REAL,
  eps            REAL,
  dividend       REAL,
  yield          REAL,
  shares         REAL,
  high52         REAL,
  low52          REAL,
  avg_vol        REAL,
  prev_close     REAL,
  is_tradable    INTEGER,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_cap    ON symbols(market_cap DESC);
CREATE INDEX IF NOT EXISTS idx_symbols_sector ON symbols(sector);

-- Membership is separate from pricing data: a symbol can be in the universe
-- before we have ever priced it, and stays there if a refresh fails.
--
-- The tmx_* columns hold what the TMX issuer reports supply directly. They
-- matter because they make the app useful before any Questrade call: market cap
-- and sector arrive with the import, so screening works immediately, and they
-- cover TSXV names Questrade classifies poorly.
CREATE TABLE IF NOT EXISTS universe (
  symbol           TEXT PRIMARY KEY,
  source           TEXT,
  listed_name      TEXT,
  exchange         TEXT,
  tmx_sector       TEXT,
  tmx_subsector    TEXT,
  tmx_market_cap   REAL,
  tmx_shares       REAL,
  listing_type     TEXT,
  hq_region        TEXT,
  index_membership TEXT,
  interlisted      TEXT,
  as_of            TEXT,
  added_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_universe_cap    ON universe(tmx_market_cap DESC);
CREATE INDEX IF NOT EXISTS idx_universe_sector ON universe(tmx_sector);

CREATE TABLE IF NOT EXISTS candles (
  symbol_id  INTEGER NOT NULL,
  interval   TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  PRIMARY KEY (symbol_id, interval, end_date)
);

-- Freshness is tracked separately from the candles themselves: a symbol that
-- legitimately returns no candles (halted, newly listed) must still count as
-- "checked", or every page view would re-request it forever.
CREATE TABLE IF NOT EXISTS candle_fetch (
  symbol_id  INTEGER NOT NULL,
  range      TEXT NOT NULL,
  fetched_at TEXT,
  points     INTEGER,
  PRIMARY KEY (symbol_id, range)
);

CREATE TABLE IF NOT EXISTS sec_facts (
  cik         TEXT PRIMARY KEY,
  ticker      TEXT,
  entity_name TEXT,
  payload     TEXT,
  fetched_at  TEXT
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Derived fundamentals, precomputed per symbol.
--
-- Only the computed numbers are kept, never the source payload: companyfacts
-- runs 2-8MB per company, so storing raw filings for the whole interlisted set
-- would be roughly a gigabyte of database to answer questions worth a few
-- hundred bytes. The filings are fetched, reduced, and discarded.
--
-- The currency column is the unit the filing reports in, and it is not
-- decoration: a
-- Canadian company can trade in CAD and report in USD, which makes any ratio
-- mixing Questrade's market cap with these figures wrong by ~35%. See
-- valuationRatios().
CREATE TABLE IF NOT EXISTS fundamentals (
  symbol             TEXT PRIMARY KEY,
  cik                TEXT,
  entity_name        TEXT,
  as_of              TEXT,
  currency           TEXT,
  debt_to_equity     REAL,
  net_debt_to_ebitda REAL,
  interest_coverage  REAL,
  current_ratio      REAL,
  ebitda             REAL,
  net_debt           REAL,
  equity             REAL,
  debt_as_of         TEXT,
  roic               REAL,
  gross_margin       REAL,
  operating_margin   REAL,
  net_margin         REAL,
  fcf                REAL,
  revenue            REAL,
  revenue_growth     REAL,
  fetched_at         TEXT
);

-- Valuation grade: where a company sits against its sector on price multiples.
--
-- Precomputed rather than derived in the screener query, because the ranking
-- has to be stable. A percentile computed over whatever rows the current filter
-- returns would mean "cheap among the things you happen to be looking at",
-- so filtering to Mining would silently regrade every miner. These percentiles
-- are always computed over the whole universe.
--
-- The individual ratios are stored alongside the score so the grade is never a
-- black box — the expanded row shows what produced it.
CREATE TABLE IF NOT EXISTS valuation (
  symbol      TEXT PRIMARY KEY,
  sector      TEXT,
  pe          REAL,
  ps          REAL,
  pb          REAL,
  pfcf        REAL,
  ev_ebitda   REAL,
  -- 0 = cheapest in sector, 100 = most expensive. Mean of the available
  -- factors' within-sector percentiles.
  score       REAL,
  grade       TEXT,
  factors     INTEGER,
  peer_count  INTEGER,
  computed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_valuation_score ON valuation(score);

-- Debt load grade: how levered a company is against its sector.
--
-- A separate table from the valuation one rather than more columns on it, since
-- two have different lifetimes. Every valuation multiple has market cap in the
-- numerator, so a price refresh invalidates all of them; debt ratios divide one
-- SEC figure by another and change only when a new filing lands. Keeping them
-- apart means a price refresh does not needlessly rewrite 400 debt rows.
--
-- Rows are also written for companies deliberately NOT graded, carrying a
-- reason in the excluded column. A bank showing debt/equity of 0.00 would rank
-- as the least indebted company in the country — XBRL does not tag deposits as
-- debt, and banks report no EBITDA, no meaningful current ratio and no interest
-- coverage. That is an inversion of reality, not a gap, so it is marked rather
-- than left to look like missing data.
CREATE TABLE IF NOT EXISTS debt (
  symbol             TEXT PRIMARY KEY,
  sector             TEXT,
  debt_to_equity     REAL,
  net_debt_to_ebitda REAL,
  interest_coverage  REAL,
  current_ratio      REAL,
  -- 0 = least indebted in sector, 100 = most. A is low, matching the value
  -- grade's convention that A is the desirable end.
  score              REAL,
  grade              TEXT,
  factors            INTEGER,
  peer_count         INTEGER,
  -- Set when a ratio breaches an absolute danger level, independent of rank.
  -- Being the least levered company in an over-levered sector is still levered.
  warning            TEXT,
  excluded           TEXT,
  computed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_debt_score ON debt(score);


-- ---------------------------------------------------------------------------
-- Research journal: notes, reminders, groups
--
-- This is the only data here you cannot regenerate. Prices and filings can be
-- refetched; your own reasoning cannot, which is why it lives in SQLite rather
-- than localStorage where clearing a browser profile would destroy it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  body        TEXT NOT NULL,
  kind        TEXT,                 -- thesis | risk | catalyst | valuation | question | note
  pinned      INTEGER DEFAULT 0,
  created_at  TEXT,
  updated_at  TEXT,
  -- What the market looked like when the note was written. Recorded because a
  -- thesis is only meaningful against the price you formed it at: "cheap at
  -- $18" reads very differently once the stock is $40.
  price_at    REAL,
  cap_at      REAL,
  currency    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_symbol ON notes(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT NOT NULL,
  due_at     TEXT NOT NULL,
  body       TEXT,
  created_at TEXT,
  done_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at) WHERE done_at IS NULL;

-- "groups" is a reserved word in SQLite (window functions), hence the prefix.
CREATE TABLE IF NOT EXISTS watch_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  note       TEXT,
  colour     TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  symbol   TEXT NOT NULL,
  added_at TEXT,
  PRIMARY KEY (group_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_group_members_symbol ON group_members(symbol);
`

export function openDb(root) {
  const dir = path.resolve(root, 'data')
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'take-stock.db'))
  // WAL keeps reads from blocking behind a refresh writing 200 rows.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/**
 * Add columns that later versions introduced. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so existing columns are read first — this keeps
 * a database created before the TMX import from having to be deleted.
 */
function migrate(db) {
  addColumns(db, 'watch_groups', {
    // Lists and tags are the same structure — a named many-to-many label on a
    // symbol. Only the intent differs: a list is a working set ("Left for
    // dead"), a tag is taxonomy ("agtech"). One table, one `kind`, so filtering
    // and membership work identically for both.
    kind: "TEXT DEFAULT 'list'",
  })

  // The fundamentals table shipped before P/B was a goal, so databases carrying
  // rows from the first sweep have neither the book value nor the reporting
  // currency the valuation grade needs. Both are backfilled by the next sweep.
  addColumns(db, 'fundamentals', {
    equity: 'REAL',
    currency: 'TEXT',
    // When the debt figure was last actually tagged. Null means no debt concept
    // resolved at all, which is NOT the same as no debt — see assessDebt().
    debt_as_of: 'TEXT',
  })

  addColumns(db, 'universe', {
    exchange: 'TEXT',
    tmx_sector: 'TEXT',
    tmx_subsector: 'TEXT',
    tmx_market_cap: 'REAL',
    tmx_shares: 'REAL',
    listing_type: 'TEXT',
    hq_region: 'TEXT',
    index_membership: 'TEXT',
    interlisted: 'TEXT',
    as_of: 'TEXT',
  })
}

/** SQLite has no ADD COLUMN IF NOT EXISTS, so read the table first. */
function addColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))
  for (const [col, type] of Object.entries(columns)) {
    if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
  }
}

const now = () => new Date().toISOString()

/** Upsert Questrade symbol snapshots. */
export function saveSymbols(db, symbols, classify) {
  const stmt = db.prepare(`
    INSERT INTO symbols (symbol, symbol_id, name, exchange, currency, security_type,
                         category, sector, market_cap, pe, eps, dividend, yield, shares,
                         high52, low52, avg_vol, prev_close, is_tradable, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol) DO UPDATE SET
      symbol_id=excluded.symbol_id, name=excluded.name, exchange=excluded.exchange,
      currency=excluded.currency, security_type=excluded.security_type,
      category=excluded.category, sector=excluded.sector, market_cap=excluded.market_cap,
      pe=excluded.pe, eps=excluded.eps, dividend=excluded.dividend, yield=excluded.yield,
      shares=excluded.shares, high52=excluded.high52, low52=excluded.low52,
      avg_vol=excluded.avg_vol, prev_close=excluded.prev_close,
      is_tradable=excluded.is_tradable, updated_at=excluded.updated_at
  `)

  const run = db.prepare('BEGIN')
  run.run()
  try {
    for (const s of symbols) {
      stmt.run(
        s.symbol,
        s.symbolId ?? null,
        s.description ?? null,
        s.listingExchange ?? null,
        s.currency ?? null,
        s.securityType ?? null,
        classify?.(s) ?? null,
        s.industrySector ?? null,
        s.marketCap ?? null,
        s.pe ?? null,
        s.eps ?? null,
        s.dividend ?? null,
        s.yield ?? null,
        s.outstandingShares ?? null,
        s.highPrice52 ?? null,
        s.lowPrice52 ?? null,
        s.averageVol3Months ?? null,
        s.prevDayClosePrice ?? null,
        s.isTradable ? 1 : 0,
        now(),
      )
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
  return symbols.length
}

/** Add symbols to the tracked universe (idempotent, re-importable). */
export function addToUniverse(db, entries, source) {
  const stmt = db.prepare(`
    INSERT INTO universe (symbol, source, listed_name, exchange, tmx_sector, tmx_subsector,
                          tmx_market_cap, tmx_shares, listing_type, hq_region,
                          index_membership, interlisted, as_of, added_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol) DO UPDATE SET
      source=excluded.source, listed_name=excluded.listed_name, exchange=excluded.exchange,
      tmx_sector=excluded.tmx_sector, tmx_subsector=excluded.tmx_subsector,
      tmx_market_cap=excluded.tmx_market_cap, tmx_shares=excluded.tmx_shares,
      listing_type=excluded.listing_type, hq_region=excluded.hq_region,
      index_membership=excluded.index_membership, interlisted=excluded.interlisted,
      as_of=excluded.as_of
  `)
  db.prepare('BEGIN').run()
  try {
    for (const e of entries) {
      stmt.run(
        e.symbol,
        source,
        e.name ?? null,
        e.exchange ?? null,
        e.sector ?? null,
        e.subSector ?? null,
        e.marketCap ?? null,
        e.shares ?? null,
        e.listingType ?? null,
        e.hqRegion ?? null,
        e.index ?? null,
        e.interlisted ?? null,
        e.asOf ?? null,
        now(),
      )
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
  return entries.length
}

/**
 * Screen the universe. This is the query Questrade cannot answer.
 *
 * @param {{minCap?: number, maxCap?: number, sector?: string, category?: string,
 *          exchange?: string, sort?: string, dir?: string, limit?: number}} q
 */
export function queryUniverse(db, q = {}) {
  // Questrade values win where present, TMX fills the gaps. This is what lets
  // screening work straight after an import, before any prices are fetched —
  // and keeps TSXV names usable, where Questrade's sector data is thin.
  const CAP = 'COALESCE(s.market_cap, u.tmx_market_cap)'

  /*
   * Sector prefers TMX, market cap prefers Questrade — deliberately opposite.
   *
   * Market cap is a number, so the fresher source wins. Sector is a *label*,
   * and the two sources use different taxonomies: Questrade says
   * "FinancialServices" and "BasicMaterials", TMX says "Financial Services"
   * and "Mining". Preferring the live value per row split single sectors in
   * two and produced 17 entries for 11 real sectors. TMX also covers every
   * imported listing, priced or not, and its taxonomy ("Oil & Gas",
   * "Clean Technology & Renewable Energy") suits a Canadian universe better.
   */
  const SECTOR = 'COALESCE(u.tmx_sector, s.sector)'

  const where = []
  const params = []

  if (q.minCap) {
    where.push(`${CAP} >= ?`)
    params.push(Number(q.minCap))
  }
  if (q.maxCap) {
    where.push(`${CAP} <= ?`)
    params.push(Number(q.maxCap))
  }
  if (q.sector) {
    where.push(`${SECTOR} = ?`)
    params.push(q.sector)
  }
  if (q.index) {
    // Single quotes: SQLite reads "" as an identifier, not an empty string.
    where.push("u.index_membership IS NOT NULL AND u.index_membership != ''")
  }
  if (q.group) {
    where.push('u.symbol IN (SELECT symbol FROM group_members WHERE group_id = ?)')
    params.push(Number(q.group))
  }
  if (q.indexName) {
    // TMX labels S&P/TSX 60 members as "60.0" and Composite members "Composite".
    where.push('u.index_membership = ?')
    params.push(q.indexName)
  }
  if (q.category) {
    where.push('s.category = ?')
    params.push(q.category)
  }
  if (q.exchange) {
    where.push('COALESCE(s.exchange, u.exchange) = ?')
    params.push(q.exchange)
  }

  // Where the last close sits in the 52-week band: 0 = at the low, 1 = at the
  // high. Computed in SQL so it can be sorted on — "show me what is near its
  // 52-week low" is a screen, not a display detail.
  const RANGE_POS = '(s.prev_close - s.low52) / NULLIF(s.high52 - s.low52, 0)'

  // Allowlist the sort column — it is interpolated, not bound.
  const SORTABLE = {
    market_cap: CAP,
    symbol: 'u.symbol',
    pe: 's.pe',
    yield: 's.yield',
    sector: SECTOR,
    name: 'COALESCE(s.name, u.listed_name)',
    prev_close: 's.prev_close',
    range_pos: RANGE_POS,
    // Ascending puts the cheapest first, which is why sortBy() special-cases it.
    value_score: 'v.score',
    // Likewise: ascending is least-indebted first.
    debt_score: 'd.score',
  }
  const sortCol = SORTABLE[q.sort] ?? CAP
  const dir = String(q.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  // Ceiling sits above the full TSX+TSXV universe (~2,000 issuers) so an
  // unfiltered screen is never silently truncated.
  const limit = Math.min(Number(q.limit) || 500, 5000)

  // LEFT JOIN, not JOIN: a symbol in the universe that Questrade has not
  // priced yet must still be screenable from its TMX figures.
  const sql = `
    SELECT u.symbol,
           COALESCE(s.name, u.listed_name)        AS name,
           COALESCE(s.sector, u.tmx_sector)       AS sector,
           COALESCE(s.market_cap, u.tmx_market_cap) AS market_cap,
           COALESCE(s.exchange, u.exchange)       AS exchange,
           s.symbol_id, s.pe, s.yield, s.eps, s.category, s.currency, s.updated_at,
           s.high52, s.low52, s.prev_close, s.avg_vol,
           ${RANGE_POS} AS range_pos,
           u.tmx_subsector, u.tmx_market_cap, u.listing_type, u.hq_region,
           u.index_membership, u.interlisted, u.as_of, u.source AS universe_source,
           v.score AS value_score, v.grade AS value_grade, v.factors AS value_factors,
           v.peer_count AS value_peers, v.ps, v.pb, v.pfcf, v.ev_ebitda,
           d.score AS debt_score, d.grade AS debt_grade, d.factors AS debt_factors,
           d.peer_count AS debt_peers, d.warning AS debt_warning, d.excluded AS debt_excluded,
           f.debt_to_equity, f.net_debt_to_ebitda, f.interest_coverage, f.current_ratio,
           f.ebitda, f.net_debt, f.equity, f.revenue, f.currency AS fund_currency,
           f.as_of AS fundamentals_as_of,
           (s.symbol IS NOT NULL) AS priced,
           (SELECT COUNT(*) FROM notes n WHERE n.symbol = u.symbol) AS note_count
    FROM universe u
    LEFT JOIN symbols s ON s.symbol = u.symbol
    LEFT JOIN fundamentals f ON f.symbol = u.symbol
    LEFT JOIN valuation v ON v.symbol = u.symbol
    LEFT JOIN debt d ON d.symbol = u.symbol
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${sortCol} IS NULL, ${sortCol} ${dir}
    LIMIT ?
  `
  return db.prepare(sql).all(...params, limit)
}

/** Sector rollup, using TMX data where Questrade has not priced a symbol. */
export function sectorSummary(db) {
  return db
    .prepare(
      // Same precedence as queryUniverse — one taxonomy, not a blend of two.
      `SELECT COALESCE(u.tmx_sector, s.sector, '(none)') AS sector,
              COUNT(*) AS count,
              SUM(COALESCE(s.market_cap, u.tmx_market_cap)) AS cap,
              AVG(s.pe) AS avg_pe,
              AVG(s.yield) AS avg_yield
       FROM universe u
       LEFT JOIN symbols s ON s.symbol = u.symbol
       WHERE COALESCE(s.market_cap, u.tmx_market_cap) IS NOT NULL
       GROUP BY COALESCE(u.tmx_sector, s.sector, '(none)')
       ORDER BY cap DESC`,
    )
    .all()
}

/** Symbols in the universe that have never been priced, or are stale. */
export function staleUniverse(db, maxAgeMs = 6 * 3600_000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
  return db
    .prepare(
      `SELECT u.symbol FROM universe u
       LEFT JOIN symbols s ON s.symbol = u.symbol
       WHERE s.symbol IS NULL OR s.updated_at IS NULL OR s.updated_at < ?`,
    )
    .all(cutoff)
    .map((r) => r.symbol)
}

// --- candles ---------------------------------------------------------------

export function saveCandles(db, symbolId, interval, candles) {
  const stmt = db.prepare(`
    INSERT INTO candles (symbol_id, interval, end_date, open, high, low, close, volume)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol_id, interval, end_date) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume
  `)
  db.prepare('BEGIN').run()
  try {
    for (const c of candles) {
      stmt.run(symbolId, interval, c.end, c.open, c.high, c.low, c.close, c.volume)
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }
}

export function getCandles(db, symbolId, interval, sinceIso) {
  return db
    .prepare(
      `SELECT end_date AS end, open, high, low, close, volume FROM candles
       WHERE symbol_id = ? AND interval = ? AND end_date >= ?
       ORDER BY end_date ASC`,
    )
    .all(symbolId, interval, sinceIso)
}

/** Record that a range was fetched, whether or not it returned data. */
export function markCandleFetch(db, symbolId, range, points) {
  db.prepare(
    `INSERT INTO candle_fetch (symbol_id, range, fetched_at, points) VALUES (?,?,?,?)
     ON CONFLICT(symbol_id, range) DO UPDATE SET fetched_at=excluded.fetched_at,
       points=excluded.points`,
  ).run(symbolId, range, now(), points)
}

/** Is the cached history for this symbol still usable? */
export function candlesFresh(db, symbolId, range, maxAgeMs) {
  const row = db
    .prepare('SELECT fetched_at FROM candle_fetch WHERE symbol_id = ? AND range = ?')
    .get(symbolId, range)
  return Boolean(row?.fetched_at) && Date.now() - Date.parse(row.fetched_at) < maxAgeMs
}

/** How much history is cached, for the UI to report. */
export function candleCoverage(db, range) {
  const row = db
    .prepare('SELECT COUNT(*) AS symbols, SUM(points) AS points FROM candle_fetch WHERE range = ?')
    .get(range)
  return { symbols: row?.symbols ?? 0, points: row?.points ?? 0 }
}

// --- SEC facts -------------------------------------------------------------

export function saveSecFacts(db, cik, ticker, payload) {
  db.prepare(
    `INSERT INTO sec_facts (cik, ticker, entity_name, payload, fetched_at) VALUES (?,?,?,?,?)
     ON CONFLICT(cik) DO UPDATE SET ticker=excluded.ticker, entity_name=excluded.entity_name,
       payload=excluded.payload, fetched_at=excluded.fetched_at`,
  ).run(cik, ticker ?? null, payload.entityName ?? null, JSON.stringify(payload), now())
}

export function getSecFacts(db, cik, maxAgeMs = 24 * 3600_000) {
  const row = db.prepare('SELECT payload, fetched_at FROM sec_facts WHERE cik = ?').get(cik)
  if (!row) return null
  if (Date.now() - Date.parse(row.fetched_at) > maxAgeMs) return null
  return JSON.parse(row.payload)
}

// ---------------------------------------------------------------------------
// Research journal
// ---------------------------------------------------------------------------

/** Notes for one symbol, pinned first then newest. */
export function listNotes(db, symbol) {
  return db
    .prepare('SELECT * FROM notes WHERE symbol = ? ORDER BY pinned DESC, created_at DESC')
    .all(symbol)
}

/** Every note, newest first — the research journal across all holdings. */
export function listAllNotes(db, { limit = 200, q = '' } = {}) {
  if (q) {
    return db
      .prepare(
        `SELECT * FROM notes WHERE body LIKE ? OR symbol LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(`%${q}%`, `%${q}%`, limit)
  }
  return db.prepare('SELECT * FROM notes ORDER BY created_at DESC LIMIT ?').all(limit)
}

export function addNote(db, note) {
  const stamp = now()
  const info = db
    .prepare(
      `INSERT INTO notes (symbol, body, kind, pinned, created_at, updated_at,
                          price_at, cap_at, currency)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      note.symbol,
      note.body,
      note.kind ?? 'note',
      note.pinned ? 1 : 0,
      stamp,
      stamp,
      note.priceAt ?? null,
      note.capAt ?? null,
      note.currency ?? null,
    )
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid)
}

export function updateNote(db, id, patch) {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
  if (!existing) return null
  db.prepare('UPDATE notes SET body = ?, kind = ?, pinned = ?, updated_at = ? WHERE id = ?').run(
    patch.body ?? existing.body,
    patch.kind ?? existing.kind,
    patch.pinned == null ? existing.pinned : patch.pinned ? 1 : 0,
    now(),
    id,
  )
  return db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
}

export const deleteNote = (db, id) => db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes

/** Note counts per symbol, for badges in the lists. */
export function noteCounts(db) {
  return db.prepare('SELECT symbol, COUNT(*) AS n FROM notes GROUP BY symbol').all()
}

// --- reminders ---

export function listReminders(db, { includeDone = false, symbol = null } = {}) {
  const where = []
  const params = []
  if (!includeDone) where.push('done_at IS NULL')
  if (symbol) {
    where.push('symbol = ?')
    params.push(symbol)
  }
  return db
    .prepare(
      `SELECT * FROM reminders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY due_at ASC`,
    )
    .all(...params)
}

export function addReminder(db, { symbol, dueAt, body }) {
  const info = db
    .prepare('INSERT INTO reminders (symbol, due_at, body, created_at) VALUES (?,?,?,?)')
    .run(symbol, dueAt, body ?? null, now())
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid)
}

export const completeReminder = (db, id) =>
  db.prepare('UPDATE reminders SET done_at = ? WHERE id = ?').run(now(), id).changes

export const deleteReminder = (db, id) =>
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id).changes

/** Anything due now or overdue — drives the badge in the nav. */
export const dueReminders = (db) =>
  db
    .prepare('SELECT * FROM reminders WHERE done_at IS NULL AND due_at <= ? ORDER BY due_at ASC')
    .all(now())

// --- groups ---

export function listGroups(db) {
  return db
    .prepare(
      `SELECT g.*, COALESCE(g.kind, 'list') AS kind, COUNT(m.symbol) AS members
       FROM watch_groups g LEFT JOIN group_members m ON m.group_id = g.id
       GROUP BY g.id ORDER BY g.name`,
    )
    .all()
}

export function createGroup(db, { name, note, colour, kind }) {
  const info = db
    .prepare('INSERT INTO watch_groups (name, note, colour, kind, created_at) VALUES (?,?,?,?,?)')
    .run(name, note ?? null, colour ?? null, kind === 'tag' ? 'tag' : 'list', now())
  return db.prepare('SELECT * FROM watch_groups WHERE id = ?').get(info.lastInsertRowid)
}

export const deleteGroup = (db, id) => {
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id)
  return db.prepare('DELETE FROM watch_groups WHERE id = ?').run(id).changes
}

export const addToGroup = (db, groupId, symbol) =>
  db
    .prepare(
      `INSERT INTO group_members (group_id, symbol, added_at) VALUES (?,?,?)
       ON CONFLICT(group_id, symbol) DO NOTHING`,
    )
    .run(groupId, symbol, now()).changes

export const removeFromGroup = (db, groupId, symbol) =>
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND symbol = ?').run(groupId, symbol)
    .changes

/** Which groups each symbol belongs to — a symbol can be in many. */
export function groupsBySymbol(db) {
  return db
    .prepare(
      `SELECT m.symbol, g.id, g.name, g.colour
       FROM group_members m JOIN watch_groups g ON g.id = m.group_id`,
    )
    .all()
}

export const groupMembers = (db, groupId) =>
  db.prepare('SELECT symbol FROM group_members WHERE group_id = ?').all(groupId).map((r) => r.symbol)

// ---------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------

/** Upsert one company's computed fundamentals. */
export function saveFundamentals(db, row) {
  db.prepare(
    `INSERT INTO fundamentals (symbol, cik, entity_name, as_of, currency, debt_to_equity,
        net_debt_to_ebitda, interest_coverage, current_ratio, ebitda, net_debt, equity, debt_as_of,
        roic, gross_margin, operating_margin, net_margin, fcf, revenue, revenue_growth, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol) DO UPDATE SET
       cik=excluded.cik, entity_name=excluded.entity_name, as_of=excluded.as_of,
       currency=excluded.currency, debt_to_equity=excluded.debt_to_equity,
       net_debt_to_ebitda=excluded.net_debt_to_ebitda,
       interest_coverage=excluded.interest_coverage, current_ratio=excluded.current_ratio,
       ebitda=excluded.ebitda, net_debt=excluded.net_debt, equity=excluded.equity,
       debt_as_of=excluded.debt_as_of, roic=excluded.roic, gross_margin=excluded.gross_margin,
       operating_margin=excluded.operating_margin, net_margin=excluded.net_margin,
       fcf=excluded.fcf, revenue=excluded.revenue,
       revenue_growth=excluded.revenue_growth, fetched_at=excluded.fetched_at`,
  ).run(
    row.symbol, row.cik ?? null, row.entityName ?? null, row.asOf ?? null, row.currency ?? null,
    row.debtToEquity ?? null, row.netDebtToEbitda ?? null, row.interestCoverage ?? null,
    row.currentRatio ?? null, row.ebitda ?? null, row.netDebt ?? null, row.equity ?? null,
    row.debtAsOf ?? null, row.roic ?? null, row.grossMargin ?? null, row.operatingMargin ?? null, row.netMargin ?? null,
    row.fcf ?? null, row.revenue ?? null, row.revenueGrowth ?? null, now(),
  )
}

/** Symbols that have never had fundamentals computed, or whose figures are stale. */
export function staleFundamentals(db, { minCap = 0, maxAgeMs = 30 * 86_400_000 } = {}) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
  return db
    .prepare(
      `SELECT u.symbol, COALESCE(u.listed_name, s.name) AS name
       FROM universe u
       LEFT JOIN symbols s ON s.symbol = u.symbol
       LEFT JOIN fundamentals f ON f.symbol = u.symbol
       WHERE COALESCE(s.market_cap, u.tmx_market_cap) >= ?
         AND (f.symbol IS NULL OR f.fetched_at < ? OR f.equity IS NULL)
       ORDER BY COALESCE(s.market_cap, u.tmx_market_cap) DESC`,
    )
    .all(minCap, cutoff)
}

export const fundamentalsCoverage = (db) =>
  db
    .prepare(
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN equity IS NOT NULL THEN 1 ELSE 0 END) AS with_equity,
              SUM(CASE WHEN revenue IS NOT NULL THEN 1 ELSE 0 END) AS with_revenue,
              SUM(CASE WHEN currency IS NOT NULL THEN 1 ELSE 0 END) AS with_currency
       FROM fundamentals`,
    )
    .get()

// ---------------------------------------------------------------------------
// Valuation grade
// ---------------------------------------------------------------------------

/** A sector needs this many graded peers before a within-sector rank means anything. */
const MIN_PEERS = 8

const positive = (x) => (Number.isFinite(x) && x > 0 ? x : null)

/**
 * Floors below which a multiple is an artifact rather than a bargain.
 *
 * Questrade returns a P/E of 0.15 for Perseus Mining while reporting no EPS at
 * all — a $5.41 share implying $36 of earnings. Left in, it sorts straight to
 * the top of a cheapest-first screen, which is the one place a bad number does
 * the most damage.
 *
 * These are set where the multiple stops being physically sensible for a going
 * concern, not where it stops being common: a company does not earn its whole
 * market value in a year. P/S is the exception and sits far lower, because
 * low-margin distributors genuinely trade at a fraction of sales. No ceilings —
 * a 350x P/S is a pre-revenue developer, which is real information.
 */
const RATIO_FLOOR = { pe: 1, ps: 0.01, pb: 0.02, pfcf: 1, ev_ebitda: 0.5 }

const plausible = (id, v) => (v != null && v >= RATIO_FLOOR[id] ? v : null)

/**
 * FX rates against CAD, from the Bank of Canada. Stored in `meta` rather than
 * fetched here so grading stays a pure local computation.
 *
 * These exist because 280 of the 406 Canadian SEC filers trade in CAD and
 * report in USD. The original rule was to suppress every cross-source ratio on
 * a currency mismatch, which was right while the app had no rate to convert
 * with — but it discarded 69% of the fundamentals we hold. A single daily
 * reference rate is a far smaller error than the ~39% one it replaces.
 */
export const saveFxRates = (db, rates) =>
  db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('fx_rates', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(JSON.stringify({ ...rates, fetchedAt: now() }))

export function getFxRates(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'fx_rates'").get()
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

/**
 * Build a converter from stored rates. Returns null when no rates are stored,
 * which puts valuationRatios() back on the original suppress-on-mismatch rule.
 */
export function fxConverter(rates) {
  if (!rates) return null
  // Everything is quoted against CAD, so cross rates go via CAD.
  const toCad = { CAD: 1, ...rates }
  return (from, to) => {
    if (!from || !to) return null
    if (from === to) return 1
    const a = toCad[from]
    const b = toCad[to]
    return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null
  }
}

/**
 * The five multiples, or null where they cannot be computed honestly.
 *
 * Only P/E is single-source. The other four divide a Questrade market cap by an
 * SEC figure, and a Canadian company routinely trades in CAD while reporting in
 * USD — so the SEC side is converted into the trading currency first. Without a
 * rate to convert with (`fx` null) the original rule stands and the ratio is
 * suppressed on any mismatch, because a silently mixed CAD/USD ratio is wrong
 * by about a third, enough to move a company two grades.
 *
 * Negative denominators yield null rather than a negative ratio. A company
 * losing money does not have a low P/E, it has no P/E, and ranking -3x as
 * "cheaper than 8x" would put every loss-maker at the top of the screen.
 */
export function valuationRatios(row, fx = null) {
  const cap = positive(row.market_cap)
  if (!cap) return { pe: null, ps: null, pb: null, pfcf: null, ev_ebitda: null }

  // Rate that turns an SEC figure into the currency the shares trade in.
  const rate =
    row.currency && row.fund_currency
      ? row.currency === row.fund_currency
        ? 1
        : (fx?.(row.fund_currency, row.currency) ?? null)
      : null
  const conv = (v) => (rate != null && Number.isFinite(v) ? v * rate : null)
  const cross = (v) => (rate != null ? v : null)
  const ebitda = positive(conv(row.ebitda))

  const revenue = positive(conv(row.revenue))
  const equity = positive(conv(row.equity))
  const fcf = positive(conv(row.fcf))
  // Net debt is legitimately negative (net cash), so it converts without the
  // positivity filter the others get.
  const netDebt = rate != null && Number.isFinite(row.net_debt) ? row.net_debt * rate : null

  return {
    pe: plausible('pe', positive(row.pe)),
    ps: plausible('ps', cross(revenue ? cap / revenue : null)),
    pb: plausible('pb', cross(equity ? cap / equity : null)),
    pfcf: plausible('pfcf', cross(fcf ? cap / fcf : null)),
    // A company whose cash exceeds its market cap produces a negative
    // enterprise value, which is not a valuation — it is a special situation.
    ev_ebitda: plausible(
      'ev_ebitda',
      cross(ebitda != null && netDebt != null && cap + netDebt > 0 ? (cap + netDebt) / ebitda : null),
    ),
  }
}

/** Percentile of each value within its own array: 0 = lowest, 100 = highest. */
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const out = new Map()
  for (const v of values) {
    if (out.has(v)) continue
    // Midpoint of the tied block, so identical multiples get identical ranks
    // instead of an order-dependent split.
    const lo = sorted.indexOf(v)
    const hi = sorted.lastIndexOf(v)
    out.set(v, sorted.length === 1 ? 50 : ((lo + hi) / 2 / (sorted.length - 1)) * 100)
  }
  return out
}

const FACTORS = ['pe', 'ps', 'pb', 'pfcf', 'ev_ebitda']

/**
 * Rank the whole universe on valuation and store the result.
 *
 * Ranking is *within sector* because the sector spread swamps the signal
 * otherwise: median P/E across these large caps runs 15.5x in Comm. & Media and
 * 40.3x in Technology, so an absolute rank mostly re-reports the sector mix and
 * calls every miner cheap. Sectors thinner than MIN_PEERS graded names fall back
 * to the whole universe, which is less meaningful but beats ranking a company
 * against two peers.
 *
 * Returns a summary; the rows land in `valuation`.
 */
export function computeValuation(db) {
  const rows = db
    .prepare(
      `SELECT u.symbol,
              COALESCE(u.tmx_sector, s.sector)         AS sector,
              COALESCE(s.market_cap, u.tmx_market_cap) AS market_cap,
              s.pe, s.currency,
              f.revenue, f.equity, f.fcf, f.ebitda, f.net_debt,
              f.currency AS fund_currency
       FROM universe u
       LEFT JOIN symbols s ON s.symbol = u.symbol
       LEFT JOIN fundamentals f ON f.symbol = u.symbol`,
    )
    .all()

  const fx = fxConverter(getFxRates(db))
  const scored = rows
    .map((r) => ({ symbol: r.symbol, sector: r.sector ?? 'Unclassified', ...valuationRatios(r, fx) }))
    .filter((r) => FACTORS.some((f) => r[f] != null))

  // Percentile tables, per factor, per sector — plus a universe-wide table for
  // the thin sectors to fall back on.
  const bySector = new Map()
  for (const r of scored) {
    if (!bySector.has(r.sector)) bySector.set(r.sector, [])
    bySector.get(r.sector).push(r)
  }

  const tableFor = (members) => {
    const t = {}
    for (const f of FACTORS) {
      const vals = members.map((m) => m[f]).filter((v) => v != null)
      t[f] = vals.length ? percentiles(vals) : null
    }
    return t
  }

  const universeTable = tableFor(scored)
  const sectorTables = new Map()
  for (const [sector, members] of bySector) {
    sectorTables.set(sector, members.length >= MIN_PEERS ? tableFor(members) : universeTable)
  }

  for (const r of scored) {
    const table = sectorTables.get(r.sector)
    const peers = bySector.get(r.sector).length
    const pcts = []
    for (const f of FACTORS) {
      if (r[f] == null || !table[f]) continue
      const p = table[f].get(r[f])
      if (p != null) pcts.push(p)
    }
    r.score = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null
    r.factors = pcts.length
    r.peer_count = peers >= MIN_PEERS ? peers : scored.length
  }

  const graded = scored.filter((r) => r.score != null)

  // Grade on quintiles of the composite. The composite is already sector-
  // neutral, so this last cut is universe-wide: an A means cheap against its
  // own sector, not cheap against Technology.
  const cut = percentiles(graded.map((r) => r.score))
  const LETTERS = [
    [20, 'A'],
    [40, 'B'],
    [60, 'C'],
    [80, 'D'],
    [Infinity, 'F'],
  ]
  for (const r of graded) {
    const p = cut.get(r.score) ?? 50
    r.grade = LETTERS.find(([edge]) => p < edge)[1]
  }

  const stamp = now()
  const stmt = db.prepare(
    `INSERT INTO valuation (symbol, sector, pe, ps, pb, pfcf, ev_ebitda,
        score, grade, factors, peer_count, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol) DO UPDATE SET
       sector=excluded.sector, pe=excluded.pe, ps=excluded.ps, pb=excluded.pb,
       pfcf=excluded.pfcf, ev_ebitda=excluded.ev_ebitda, score=excluded.score,
       grade=excluded.grade, factors=excluded.factors, peer_count=excluded.peer_count,
       computed_at=excluded.computed_at`,
  )

  db.prepare('BEGIN').run()
  try {
    // Companies that lost their last usable ratio (a filing revision, a swing
    // to a loss) must lose the grade too, or the screener shows a stale letter.
    db.prepare('DELETE FROM valuation').run()
    for (const r of graded) {
      stmt.run(
        r.symbol, r.sector, r.pe, r.ps, r.pb, r.pfcf, r.ev_ebitda,
        r.score, r.grade, r.factors, r.peer_count, stamp,
      )
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }

  const byGrade = {}
  for (const r of graded) byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1
  return {
    graded: graded.length,
    universe: rows.length,
    byGrade,
    multiFactor: graded.filter((r) => r.factors >= 2).length,
    computedAt: stamp,
  }
}

// ---------------------------------------------------------------------------
// Debt load grade
// ---------------------------------------------------------------------------

/**
 * The four leverage metrics and which way is healthy.
 *
 * Unlike the valuation multiples these are all SEC-over-SEC — both sides of
 * every ratio come from the same filing in the same currency — so there is no
 * cross-source mixing and nothing to suppress. That is why coverage is better
 * here than for the value grade despite needing the same filings.
 */
const DEBT_FACTORS = [
  { id: 'debt_to_equity', lowerIsBetter: true },
  // Negative means net cash, which is the healthiest state there is. It cannot
  // mean negative EBITDA: metrics.js returns null in that case rather than a
  // ratio whose sign would be ambiguous.
  { id: 'net_debt_to_ebitda', lowerIsBetter: true },
  { id: 'interest_coverage', lowerIsBetter: false },
  { id: 'current_ratio', lowerIsBetter: false },
]

/**
 * Absolute danger levels, checked independently of the sector ranking.
 *
 * A sector-relative grade answers "levered compared to peers", which is the
 * right default — a pipeline at 6x net debt/EBITDA is normal for a pipeline.
 * It is also, separately, a lot of debt. These thresholds carry that second
 * fact, so being the healthiest company in an over-levered sector does not read
 * as safe.
 */
/*
 * Every test goes through num(), never a bare comparison on the raw field.
 * `null < 1.5` is true in JavaScript — null coerces to 0 — so comparing a
 * missing metric directly fires the alarm on absence of data. That inverted
 * two of these four before it was caught: companies with no interest-coverage
 * figure at all were being flagged as unable to cover their interest.
 */
const num = (v) => (Number.isFinite(v) ? v : null)

const DEBT_ALARMS = [
  {
    label: 'net debt over 5x EBITDA',
    test: (r) => num(r.net_debt_to_ebitda) > 5,
  },
  {
    label: 'debt over 3x equity',
    test: (r) => num(r.debt_to_equity) > 3,
  },
  {
    /*
     * Gated on the company actually being levered.
     *
     * Interest coverage goes negative whenever operating income does, and 79 of
     * the 180 companies with the metric are negative — but 56 of those carry
     * almost no debt. They are loss-making explorers, which the ranking already
     * reflects; flagging them as a debt danger fires the alarm on the wrong
     * fact. Ungated this alone warned 99 of 359 companies, which is often
     * enough that the mark stops carrying information.
     */
    label: 'interest barely covered',
    test: (r) => num(r.interest_coverage) != null && r.interest_coverage < 1.5 && num(r.debt_to_equity) > 0.25,
  },
  {
    /*
     * Well below 1, not merely under it. Capital-intensive businesses with
     * dependable cash flow routinely run a current ratio under 1 — Canadian
     * Pacific does — so "under 1" flags normal operations, not distress.
     */
    label: 'current assets under half current liabilities',
    test: (r) => num(r.current_ratio) != null && r.current_ratio < 0.5,
  },
]

/**
 * Sectors where these metrics do not describe the business.
 *
 * Banks and insurers are the most leveraged institutions in the economy, and
 * every metric here reads the opposite: deposits are not tagged as debt, there
 * is no EBITDA, interest is revenue rather than cost, and the current/
 * non-current split does not apply. Grading them produces a confident A for the
 * most levered companies in the universe.
 */
const DEBT_EXCLUDED_SECTORS = new Set(['financialservices', 'financials', 'financial'])

const sectorKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '')

/**
 * Which alarms a company trips, as a sentence, or null.
 *
 * Each test reads raw fields, so a null simply fails the comparison and the
 * alarm does not fire — absence of data is never treated as danger.
 */
function debtWarning(row) {
  const hits = DEBT_ALARMS.filter((a) => a.test(row) === true).map((a) => a.label)
  return hits.length ? hits.join('; ') : null
}

/**
 * Rank the universe on debt load and store the result.
 *
 * Same shape as computeValuation — within-sector percentiles, averaged over
 * whatever factors exist, cut into universe-wide quintiles — so one letter
 * means one thing across both columns. A is least indebted.
 */
export function computeDebt(db) {
  const rows = db
    .prepare(
      `SELECT u.symbol,
              COALESCE(u.tmx_sector, s.sector) AS sector,
              f.debt_to_equity, f.net_debt_to_ebitda, f.interest_coverage, f.current_ratio
       FROM universe u
       LEFT JOIN symbols s ON s.symbol = u.symbol
       JOIN fundamentals f ON f.symbol = u.symbol`,
    )
    .all()

  const all = rows.map((r) => ({ ...r, sector: r.sector ?? 'Unclassified' }))

  /*
   * Every financial with a filing is marked, whether or not any debt factor
   * survived. The mark means "deliberately not graded", which is true
   * regardless — and gating it on having data made the banks whose debt tag was
   * suppressed fall back to a bare dash, which reads as missing data rather
   * than as the judgement it is.
   */
  const excluded = all.filter((r) => DEBT_EXCLUDED_SECTORS.has(sectorKey(r.sector)))
  const scored = all.filter(
    (r) =>
      !DEBT_EXCLUDED_SECTORS.has(sectorKey(r.sector)) &&
      DEBT_FACTORS.some((f) => Number.isFinite(r[f.id])),
  )

  const bySector = new Map()
  for (const r of scored) {
    if (!bySector.has(r.sector)) bySector.set(r.sector, [])
    bySector.get(r.sector).push(r)
  }

  const tableFor = (members) => {
    const t = {}
    for (const f of DEBT_FACTORS) {
      const vals = members.map((m) => m[f.id]).filter(Number.isFinite)
      t[f.id] = vals.length ? percentiles(vals) : null
    }
    return t
  }

  const universeTable = tableFor(scored)
  const sectorTables = new Map()
  for (const [sector, members] of bySector) {
    sectorTables.set(sector, members.length >= MIN_PEERS ? tableFor(members) : universeTable)
  }

  for (const r of scored) {
    const table = sectorTables.get(r.sector)
    const peers = bySector.get(r.sector).length
    const pcts = []
    for (const f of DEBT_FACTORS) {
      if (!Number.isFinite(r[f.id]) || !table[f.id]) continue
      const p = table[f.id].get(r[f.id])
      if (p == null) continue
      // Flip the metrics where a high reading is healthy, so a low composite
      // always means low debt regardless of which factors a company has.
      pcts.push(f.lowerIsBetter ? p : 100 - p)
    }
    r.score = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null
    r.factors = pcts.length
    r.peer_count = peers >= MIN_PEERS ? peers : scored.length
    r.warning = debtWarning(r)
  }

  const graded = scored.filter((r) => r.score != null)

  const cut = percentiles(graded.map((r) => r.score))
  const LETTERS = [
    [20, 'A'],
    [40, 'B'],
    [60, 'C'],
    [80, 'D'],
    [Infinity, 'F'],
  ]
  for (const r of graded) {
    const p = cut.get(r.score) ?? 50
    r.grade = LETTERS.find(([edge]) => p < edge)[1]
  }

  const stamp = now()
  const stmt = db.prepare(
    `INSERT INTO debt (symbol, sector, debt_to_equity, net_debt_to_ebitda, interest_coverage,
        current_ratio, score, grade, factors, peer_count, warning, excluded, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol) DO UPDATE SET
       sector=excluded.sector, debt_to_equity=excluded.debt_to_equity,
       net_debt_to_ebitda=excluded.net_debt_to_ebitda,
       interest_coverage=excluded.interest_coverage, current_ratio=excluded.current_ratio,
       score=excluded.score, grade=excluded.grade, factors=excluded.factors,
       peer_count=excluded.peer_count, warning=excluded.warning,
       excluded=excluded.excluded, computed_at=excluded.computed_at`,
  )

  db.prepare('BEGIN').run()
  try {
    db.prepare('DELETE FROM debt').run()
    for (const r of graded) {
      stmt.run(
        r.symbol, r.sector, r.debt_to_equity, r.net_debt_to_ebitda, r.interest_coverage,
        r.current_ratio, r.score, r.grade, r.factors, r.peer_count, r.warning, null, stamp,
      )
    }
    // Excluded companies get a row too, so the column can say "not comparable"
    // rather than showing the same dash as a company with no filings at all.
    for (const r of excluded) {
      stmt.run(
        r.symbol, r.sector, r.debt_to_equity, r.net_debt_to_ebitda, r.interest_coverage,
        r.current_ratio, null, null, 0, 0, null, 'financials', stamp,
      )
    }
    db.prepare('COMMIT').run()
  } catch (err) {
    db.prepare('ROLLBACK').run()
    throw err
  }

  const byGrade = {}
  for (const r of graded) byGrade[r.grade] = (byGrade[r.grade] ?? 0) + 1
  return {
    graded: graded.length,
    excluded: excluded.length,
    warned: graded.filter((r) => r.warning).length,
    multiFactor: graded.filter((r) => r.factors >= 2).length,
    byGrade,
    computedAt: stamp,
  }
}

export const debtCoverage = (db) =>
  db
    .prepare(
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN grade IS NOT NULL THEN 1 ELSE 0 END) AS graded,
              SUM(CASE WHEN factors >= 2 THEN 1 ELSE 0 END) AS multi_factor,
              SUM(CASE WHEN warning IS NOT NULL THEN 1 ELSE 0 END) AS warned,
              SUM(CASE WHEN excluded IS NOT NULL THEN 1 ELSE 0 END) AS excluded,
              MAX(computed_at) AS computed_at
       FROM debt`,
    )
    .get()

export const valuationCoverage = (db) =>
  db
    .prepare(
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN factors >= 2 THEN 1 ELSE 0 END) AS multi_factor,
              MAX(computed_at) AS computed_at
       FROM valuation`,
    )
    .get()

/**
 * Everything the lists need to badge a row, in one round trip.
 *
 * Previously the note count was a subquery inside the universe query, so it was
 * only as fresh as the last full page load — write a note, go back to the
 * Screener, and the badge was missing until a reload. Serving annotations
 * separately lets the client refresh them after any write without re-running
 * the (much heavier) universe query.
 */
export function annotations(db) {
  const out = {}
  const row = (symbol) =>
    (out[symbol] ??= { notes: 0, reminders: 0, overdue: 0, lists: [], tags: [] })

  for (const r of db.prepare('SELECT symbol, COUNT(*) n FROM notes GROUP BY symbol').all()) {
    row(r.symbol).notes = r.n
  }
  for (const r of db
    .prepare(
      `SELECT symbol, COUNT(*) n, SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) overdue
       FROM reminders WHERE done_at IS NULL GROUP BY symbol`,
    )
    .all(now())) {
    const e = row(r.symbol)
    e.reminders = r.n
    e.overdue = r.overdue ?? 0
  }
  for (const r of db
    .prepare(
      `SELECT m.symbol, g.id, g.name, g.colour, COALESCE(g.kind,'list') AS kind
       FROM group_members m JOIN watch_groups g ON g.id = m.group_id`,
    )
    .all()) {
    const e = row(r.symbol)
    ;(r.kind === 'tag' ? e.tags : e.lists).push({ id: r.id, name: r.name, colour: r.colour })
  }
  return out
}

// ---------------------------------------------------------------------------
// Refresh health
// ---------------------------------------------------------------------------

/**
 * What the last run of a job cost, kept in `meta`.
 *
 * In-memory state would be enough to drive a progress bar, but the useful
 * question is asked *before* starting a run — "what did this cost last time,
 * and do I need it again?" — which is usually the first thing after a page
 * reload, when in-memory state is gone.
 */
export const saveRunSummary = (db, kind, summary) =>
  db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(`run:${kind}`, JSON.stringify({ ...summary, at: now() }))

export function getRunSummary(db, kind) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`run:${kind}`)
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

/**
 * Everything the refresh panel needs, in one round trip.
 *
 * Deliberately all local reads — opening the panel must never itself spend API
 * budget, which would make the thing that reports on cost a source of it.
 */
export function healthStats(
  db,
  { candleRange = '1m', candleTtlMs = 12 * 3600_000, minCap = 0 } = {},
) {
  const one = (sql, ...p) => db.prepare(sql).get(...p)
  const candleCutoff = new Date(Date.now() - candleTtlMs).toISOString()
  const staleCutoff = new Date(Date.now() - 6 * 3600_000).toISOString()

  const prices = one(
    `SELECT COUNT(*) AS priced,
            MIN(updated_at) AS oldest,
            MAX(updated_at) AS newest,
            SUM(CASE WHEN updated_at < ? THEN 1 ELSE 0 END) AS stale
     FROM symbols WHERE updated_at IS NOT NULL`,
    staleCutoff,
  )

  const candles = one(
    `SELECT COUNT(*) AS tracked,
            SUM(CASE WHEN fetched_at >= ? THEN 1 ELSE 0 END) AS fresh,
            SUM(points) AS points,
            MIN(fetched_at) AS oldest
     FROM candle_fetch WHERE range = ?`,
    candleCutoff,
    candleRange,
  )

  const fundamentals = one(
    `SELECT COUNT(*) AS rows,
            SUM(CASE WHEN equity IS NOT NULL THEN 1 ELSE 0 END) AS with_equity,
            MIN(fetched_at) AS oldest,
            MAX(fetched_at) AS newest
     FROM fundamentals`,
  )

  return {
    universe: one('SELECT COUNT(*) AS n FROM universe').n,
    prices: {
      ...prices,
      // What "Refresh prices" would actually target if pressed right now.
      wouldFetch: staleUniverse(db).length,
    },
    candles: { ...candles, range: candleRange },
    fundamentals: {
      ...fundamentals,
      // Scoped to the caller's cap filter, because the button is too — the
      // unscoped figure would overstate the cost of the press by ~9x.
      wouldFetch: staleFundamentals(db, { minCap }).length,
      minCap,
    },
    valuation: valuationCoverage(db),
    debt: debtCoverage(db),
    fx: getFxRates(db),
    lastRun: {
      prices: getRunSummary(db, 'prices'),
      fundamentals: getRunSummary(db, 'fundamentals'),
    },
  }
}

export function dbStats(db) {
  const one = (sql) => db.prepare(sql).get()
  return {
    universe: one('SELECT COUNT(*) AS n FROM universe').n,
    symbols: one('SELECT COUNT(*) AS n FROM symbols').n,
    priced: one('SELECT COUNT(*) AS n FROM symbols WHERE market_cap IS NOT NULL').n,
    candles: one('SELECT COUNT(*) AS n FROM candles').n,
    secFilers: one('SELECT COUNT(*) AS n FROM sec_facts').n,
    fundamentals: one('SELECT COUNT(*) AS n FROM fundamentals').n,
    graded: one('SELECT COUNT(*) AS n FROM valuation').n,
    debtGraded: one('SELECT COUNT(*) AS n FROM debt WHERE grade IS NOT NULL').n,
  }
}
