#!/usr/bin/env node
/**
 * Import TMX issuer reports into the local universe table.
 *
 *   npm run import-tmx -- downloads/*.xlsx
 *   npm run import-tmx -- downloads            # a whole folder
 *   npm run import-tmx -- downloads --dry-run
 *
 * Source: TMX Datalinx "Sector News & Events" reports — one .xlsx per sector
 * (Technology, Mining, Energy, Life Sciences, Clean Technology, Diversified
 * Industries). Each workbook holds a TSX sheet and a TSXV sheet.
 *
 * These reports carry far more than a ticker list: market cap, shares
 * outstanding, sector and sub-sector, HQ region, listing type and index
 * membership. All of it is stored, which is what lets the screener work
 * immediately after import — before any Questrade call.
 *
 * Column *positions* differ between the TSX and TSXV sheets (TSXV carries an
 * extra PO ID column), so everything is located by header name.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readXlsx } from './lib/xlsx.js'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `This needs Node 22.5+ for the built-in node:sqlite, but you are on ${process.version}.\n` +
      `Run "nvm use" in the project directory (.nvmrc pins 22) and try again.`,
  )
  process.exit(1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { openDb, addToUniverse, dbStats } = await import('../vite-plugins/db.js')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const inputs = args.filter((a) => !a.startsWith('--'))

if (!inputs.length) {
  console.error(`Usage: npm run import-tmx -- <files-or-folder> [--dry-run]

Examples:
  npm run import-tmx -- downloads
  npm run import-tmx -- downloads/technology-*.xlsx --dry-run`)
  process.exit(1)
}

/** Expand folders into the spreadsheet/CSV files inside them. */
const files = inputs.flatMap((input) => {
  const stat = fs.existsSync(input) ? fs.statSync(input) : null
  if (!stat) {
    console.warn(`  ! not found: ${input}`)
    return []
  }
  if (stat.isDirectory()) {
    return fs
      .readdirSync(input)
      .filter((f) => /\.(xlsx|csv)$/i.test(f))
      .map((f) => path.join(input, f))
  }
  return [input]
})

if (!files.length) {
  console.error('No .xlsx or .csv files found.')
  process.exit(1)
}

// --- header matching -------------------------------------------------------

const norm = (h) => String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

const FIELDS = {
  symbol: /^(root ticker|ticker|symbol|root|trading symbol)$/,
  name: /^(name|company|company name|issuer|issuer name)$/,
  exchange: /^exchange$/,
  marketCap: /^market cap/,
  shares: /^o\/s shares/,
  sector: /^sector$/,
  subSector: /^(sub-?\s?sector)$/,
  hqRegion: /^hq region$/,
  listingType: /^listing type$/,
  index: /index$/,
  interlisted: /^interlisted/,
}

function mapHeaders(headerRow) {
  const cells = headerRow.map(norm)
  const found = {}
  for (const [field, re] of Object.entries(FIELDS)) {
    const idx = cells.findIndex((c) => c && re.test(c))
    if (idx >= 0) found[field] = idx
  }
  return found
}

/**
 * TMX writes class shares as "CTC.A" or "CTC/A"; Questrade wants dots plus an
 * exchange suffix — .TO for Toronto, .VN for TSX Venture.
 */
function toQuestradeSymbol(rawSymbol, exchange) {
  const base = String(rawSymbol).toUpperCase().trim().replace(/\s+/g, '').replace(/\//g, '.')
  if (!base || !/^[A-Z0-9.]+$/.test(base)) return null
  const venture = /venture|tsxv|^v$/i.test(String(exchange ?? '').trim())
  return `${base}.${venture ? 'VN' : 'TO'}`
}

// --- read every sheet of every file ----------------------------------------

/** Rows keyed by symbol so a company appearing twice merges rather than duplicates. */
const bySymbol = new Map()
const report = []
let skipped = 0

function ingestGrid(rows, label) {
  const headerIndex = rows.findIndex((r) => r.some((c) => FIELDS.symbol.test(norm(c))))
  if (headerIndex < 0) return { label, rows: 0, skipped: true }

  const cols = mapHeaders(rows[headerIndex])
  let count = 0

  for (const row of rows.slice(headerIndex + 1)) {
    const rawSymbol = row[cols.symbol]
    if (!rawSymbol) continue
    const exchange = cols.exchange != null ? row[cols.exchange] : ''
    const symbol = toQuestradeSymbol(rawSymbol, exchange)
    if (!symbol) {
      skipped++
      continue
    }

    const pick = (f) => (cols[f] != null ? row[cols[f]] : null)
    const num = (v) => (typeof v === 'number' ? v : Number(v)) || null

    bySymbol.set(symbol, {
      symbol,
      name: pick('name') ?? null,
      exchange: String(exchange ?? '').trim() || null,
      sector: pick('sector') ?? null,
      subSector: pick('subSector') ?? null,
      marketCap: num(pick('marketCap')),
      shares: num(pick('shares')),
      listingType: pick('listingType') ?? null,
      hqRegion: pick('hqRegion') ?? null,
      index: pick('index') ?? null,
      interlisted: pick('interlisted') ?? null,
      asOf: null,
    })
    count++
  }
  return { label, rows: count, skipped: false }
}

for (const file of files) {
  const base = path.basename(file)
  if (/\.csv$/i.test(file)) {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
    const delim = [',', '\t', ';', '|']
      .map((d) => [d, (text.split('\n')[0].match(new RegExp(`\\${d}`, 'g')) ?? []).length])
      .sort((a, b) => b[1] - a[1])[0][0]
    const rows = text.split(/\r?\n/).filter(Boolean).map((l) => parseCsvLine(l, delim))
    report.push({ file: base, ...ingestGrid(rows, base) })
  } else {
    for (const sheet of readXlsx(file)) {
      report.push({ file: base, ...ingestGrid(sheet.rows, sheet.name) })
    }
  }
}

function parseCsvLine(line, delim) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === delim) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

// --- report ----------------------------------------------------------------

console.log(`Read ${files.length} file(s):\n`)
for (const r of report) {
  const tag = r.skipped ? 'no ticker column (summary sheet)' : `${r.rows} listings`
  console.log(`  ${r.file}  ›  ${r.label}: ${tag}`)
}

const entries = [...bySymbol.values()]
const tsx = entries.filter((e) => e.symbol.endsWith('.TO')).length
const withCap = entries.filter((e) => e.marketCap).length
const sectors = new Set(entries.map((e) => e.sector).filter(Boolean))

console.log(`\n${entries.length} unique listings — ${tsx} TSX, ${entries.length - tsx} TSXV`)
console.log(`  with market cap : ${withCap}`)
console.log(`  sectors         : ${[...sectors].join(', ') || '(none)'}`)
if (skipped) console.log(`  unparseable rows: ${skipped}`)

if (dryRun) {
  console.log('\n--dry-run: nothing written. Sample:')
  for (const e of entries.slice(0, 5)) {
    console.log(
      `   ${e.symbol.padEnd(11)} ${(e.sector ?? '-').padEnd(14)} ` +
        `${e.marketCap ? '$' + (e.marketCap / 1e6).toFixed(0) + 'M' : '-'}  ${e.name ?? ''}`,
    )
  }
  process.exit(0)
}

const db = openDb(root)
addToUniverse(db, entries, `tmx:${files.map((f) => path.basename(f)).join(',')}`.slice(0, 200))
console.log(`\nWrote ${entries.length} listings.`)
console.log('Database now holds:', dbStats(db))
console.log('\nScreener works immediately using TMX market caps.')
console.log('Press "Refresh prices" there for live prices, P/E and yield from Questrade.')
