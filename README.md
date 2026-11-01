# take-stock

A personal stock research tool. Pulls fundamentals straight from SEC filings,
computes a curated set of quality metrics, and keeps every underlying data point
one click away.

```bash
nvm use          # Node 22.5+ required, for the built-in node:sqlite
npm install
npm run dev
```

**Node 22.5+ is required** (`.nvmrc` pins 22). The local store uses the built-in
`node:sqlite` rather than a native dependency; it is still flagged experimental
by Node, so expect a warning on startup.

## The universe, and why it needs importing

Questrade has **no screener endpoint** (`symbols/screener`, `markets/screener`
and friends all 404), and its symbol search cannot be enumerated: `prefix=A` is
still returning rows at offset 30,000, by which point it is no longer even
respecting the prefix, and only ~2 in 20 results are Canadian. Answering "every
TSX company over $2B" therefore requires a locally maintained list.

Source: **TMX Datalinx → Sector News & Events**, which publishes one `.xlsx`
per sector (Technology, Mining, Energy, Life Sciences, Clean Technology,
Diversified Industries). Together they cover ~2,000 TSX and TSXV issuers.

```bash
npm run import-tmx -- downloads            # a folder of .xlsx/.csv
npm run import-tmx -- downloads --dry-run  # preview, writes nothing
```

Then open **Screener** → **Refresh prices**.

`.xlsx` is read directly — `scripts/lib/xlsx.js` is a dependency-free reader
(an xlsx is a ZIP of XML, and Node has zlib), so there is no conversion step.
The reports carry far more than tickers: market cap, shares outstanding,
sector and sub-sector, HQ region, listing type and **index membership**. All of
it is stored, which is why the screener works immediately after import, before
any Questrade call.

Three things the importer has to get right:

- **Column positions differ between the TSX and TSXV sheets** (TSXV carries an
  extra `PO ID` column), so everything is located by header name, and the
  header itself sits below a disclaimer preamble.
- **TMX reports the *root* ticker, not the trading symbol.** Rogers files as
  `RCI` but trades as `RCI.B`, Teck as `TECK.B`, CGI as `GIB.A`, Brookfield
  Infrastructure as `BIP.UN`. The refresh detects symbols that fail to resolve
  and searches the root to find the real listing — 83 of 2,018 on a full import.
- **Picking the right share class needs market cap, not symbol shape.** The
  shortest or first-alphabetical candidate is the thin voting class every time
  (`RCI.A`, `TECK.A`, `BIP.W`). Candidates are priced and the largest wins.
  Where a root resolves to a *real but wrong* listing — `CTC.TO` prices at
  $0.7B while TMX reports Canadian Tire at $10.3B — a divergence check against
  TMX's own figure catches it and switches to `CTC.A.TO`.

### Index membership

The reports flag S&P/TSX 60 and Composite membership, which is otherwise
licensed data with no free feed. The TSX 60 view uses it when present and falls
back to the hand-curated list in `src/data/tsx60.js` otherwise. Checked against
TMX, that curated list had 3 companies missing, 5 that are not members, and
several wrong share classes — a fair illustration of why the import is worth it.

## Local storage

`data/take-stock.db` (gitignored) holds the universe, symbol snapshots, candles
and SEC filing payloads. It exists for two reasons: SEC `companyfacts` payloads
run 2–8MB each, so the previous in-memory cache re-downloaded over 100MB on
every reload; and screening by market cap or sector is only possible against a
table we can query. It also cuts API usage substantially.

## Data sources

| Data | Source | Coverage | Status |
| --- | --- | --- | --- |
| Financial statements, filings | SEC EDGAR XBRL | US filers + cross-listed Canadians | Live — free, keyless |
| Prices, market cap, P/E, yield | Questrade API | **All TSX / TSXV / US listings** | Needs your token — see below |
| CAD exchange rates | Bank of Canada Valet | USD, EUR | Live — free, keyless |

Neither source alone is sufficient for Canadian investing: SEC has the depth but
not the coverage, Questrade has the coverage but no financial statements. The
app uses each for what it is good at, and refuses to combine them when doing so
would be wrong (see currency, below).

### Connecting Questrade

The API Centre is **not** in the trading platform, and API access is **off by
default** — both of which make it easy to conclude the API doesn't exist.

1. Go to <https://apphub.questrade.com/UI/UserApps.aspx> — or on questrade.com,
   the drop-down under your login name (top right) → **API centre**.
2. Click **Activate API** and accept the API access agreement.
3. Click **Register a personal app**, give it a name and description, save.
4. In the app's **Authorizations** section, click **+ New device** and give it a
   name. This is the only token-minting action in the current App Hub UI —
   older guides describe a separate "Generate new token" button that no longer
   exists. The *Consumer key* on the app page is the OAuth `client_id` and is
   **not** what this app uses.
5. **Copy the refresh token before closing the dialog** — Questrade does not
   retain it in readable form, so it is displayed exactly once.

**Enable both OAuth scopes on the app.** Questrade's scope names do not match
its endpoint grouping: the `symbols/*` reference endpoints (needed to turn a
ticker into the `symbolId` that every other call takes) sit under *"Retrieve
balances, positions, orders and executions"*, **not** under *"Retrieve delayed
and real-time market data"*. Verified empirically — with market data alone,
`markets/quotes` and `markets/candles` work while `symbols/search` returns
`1016 Request is out of allowed OAuth scopes`, which makes the API unusable
here. Least privilege is not available; the token necessarily carries account
read access, which is why it is kept server-side.
6. Put it in `.env.local`: `QUESTRADE_REFRESH_TOKEN=your-token-here`
7. Restart `npm run dev`.

The token is held by the dev server (`vite-plugins/questrade.js`), never the
browser. This is not optional tidiness: Questrade refresh tokens are
**single-use and rotate on every refresh**, so a browser reload that lost the
rotated value would break authentication permanently. The plugin persists each
new token to `.questrade-token.json` (gitignored) the instant it is issued. The
token also reaches account positions and balances, so it does not belong in
`localStorage`. Manual tokens expire after 7 days unused.

Questrade provides **no financial statements** — only prices and a snapshot
(market cap, P/E, EPS, dividend, yield, shares outstanding, 52-week range).

Coverage is **SEC filers only**. Most ETFs and funds either file differently or
not at all.

### Canadian coverage

Canadian companies cross-listed in the US file with SEC under the
Multijurisdictional Disclosure System, so many are covered — but in three tiers:

| Tier | Examples | Status |
| --- | --- | --- |
| Cross-listed, reports under **US GAAP** | Enbridge, CN Rail, Shopify | **Works** |
| Cross-listed, reports under **IFRS** | Cameco, Brookfield, RBC, TD, Suncor, Teck, Agnico, BCE | **Works** — via the `ifrs-full` mapping in `IFRS_TAGS` |
| **TSX-only**, no US listing | Constellation Software, Aritzia, Loblaw, Power Corp | **Not covered** — never files with SEC; would need SEDAR+ |

IFRS tags in `IFRS_TAGS` were selected by frequency across a corpus of 12
Canadian IFRS filers (banks, miners, energy, telecom, insurance) rather than
from the taxonomy spec, so they match what companies actually tag. Coverage of
the 29 base metrics runs 26/29 for miners and industrials down to ~15/29 for
banks — but US banks score the same, so that is the business model, not the
taxonomy. Concepts most IFRS filers simply do not tag: operating income (only
3 of 12), R&D, and SG&A.

Insurers are the weakest case: IFRS 17 changed revenue presentation, and
Manulife's `Revenue` tag does not correspond to what you would call top-line
revenue. Check the tag shown beside each row on the Financials tab.

Two Canadian-specific traps are handled: annual figures are selected on
`fp === "FY"` rather than form name (Canadian filers use 40-F, and CN Rail files
its year-end balance sheet under 6-K), and many report in **CAD** — the unit is
read from the filing, though the formatter still renders a bare `$`.

Beware ticker collisions when searching: the SEC index is US tickers, so `T`
resolves to AT&T (not Telus), `L` to Loews (not Loblaw), and `MG` to Mistras
(not Magna).

SEC requires every automated request to identify itself with a contact address.
Browsers forbid JS from setting `User-Agent`, and `www.sec.gov` sends no CORS
headers, so all SEC traffic is proxied through the Vite dev server
(`vite.config.js`). To use your own address:

```bash
echo 'SEC_USER_AGENT=take-stock/0.1 (you@example.com)' > .env.local
```

### The TSX-only gap

**Canada does not mandate XBRL.** The CSA runs it as a voluntary, supplementary
programme; issuers are required to file financial statements as PDF, and SEDAR+
has no public API. There is therefore no Canadian equivalent of SEC's
`companyfacts` endpoint, and no free structured source of TSX fundamentals.

Consequence: companies listed only in Canada — Constellation Software,
Alimentation Couche-Tard, Loblaw, National Bank, Intact, WSP — get prices and a
market snapshot, but no statements, margins, growth or returns. Roughly 43 of
the ~64 TSX 60 large caps cross-list in the US and so do have full fundamentals;
coverage falls off sharply below large cap. Closing that gap requires a
commercial vendor (EODHD, FMP) or parsing PDFs.

Yahoo Finance and Stooq were evaluated as free price sources and both failed:
Yahoo returns HTTP 429 at the IP level, Stooq gates CSVs behind a JS challenge.

### Currency

Canadian filers report in CAD, USD, or both, and the trading currency is not
always the reporting currency — **280 of the 406 SEC filers in the universe
trade in CAD and report in USD**. Cross-source valuation ratios (P/S, P/B,
P/FCF, EV/EBITDA) need a Questrade market cap *and* SEC fundamentals, so mixing
the two unconverted is wrong by the exchange rate, currently ~39%.

The SEC side is therefore **converted into the trading currency** using daily
reference rates from the **Bank of Canada Valet API** (`FXUSDCAD`, `FXEURCAD`) —
free, keyless, official, and the only figure in the app that needs no vendor.
Rates are cached in `meta` and refreshed with each fundamentals sweep.

Where no rate is available the original rule still applies: the ratio is
**suppressed entirely** rather than silently mixed. That was the behaviour
everywhere before rates existed, and it cost 69% of the fundamentals — the
multi-factor grade covered 73 companies without conversion and 254 with it.

## Chart ranges

| Range | Candle | Cached for | Shows |
| --- | --- | --- | --- |
| 1d | 5 minutes | 2 min | the most recent session |
| 5d | 15 minutes | 5 min | the last five sessions |
| 1m / 6m / 1y | daily | 12 h | as labelled |
| 5y | weekly | 12 h | as labelled |

Two things make the intraday ranges different from the rest.

**The window is padded, then trimmed.** Requests reach back further in calendar
days than the label implies — 4 days for `1d`, 9 for `5d` — because a weekend or
holiday would otherwise starve them, and a `1d` request before Monday's open
would return nothing at all. That reliably over-delivers (a 4-day window asked
for on a Friday comes back with five sessions), so the response is trimmed to
the last N *distinct session dates* afterwards. Only the data knows which days
actually traded; a calendar cannot tell you the market was shut for Victoria Day.

**The cache is short.** Daily bars settle at the close, but an intraday series is
stale the moment it is stored. On the 12-hour TTL the rest of the app uses, a
chart opened at 10am would still show 10am at dinner.

Candles are plotted by index rather than by timestamp, so overnight gaps and
weekends collapse instead of leaving dead space — which is what makes a 5-session
chart readable. The tooltip detects an intraday series (two candles sharing a
date) and leads with the time instead of the date.

**None of this is live.** Questrade market data is delayed unless the account
carries a real-time subscription, and the smallest candle offered here is five
minutes. For "where is it trading right now" there is a **Live ↗** link beside
the range buttons, pointing at the listing's own page on TMX Money — the listing
exchange, so it covers TSXV juniors that US aggregators quote badly or miss.

## The valuation grade

The Screener's **Value** column ranks companies A (cheap) to F (expensive), in
the spirit of AAII's valuation grade — which does not cover TSX-only names, and
is the reason this exists locally.

Five multiples feed it: **P/E** (Questrade), and **P/S**, **P/B**, **P/FCF**,
**EV/EBITDA** (Questrade market cap over SEC fundamentals, FX-converted). A
company is graded on whatever subset it has; the count is in the tooltip, and a
single-factor grade is drawn with a dashed border because it is a thin read.

Three things it does deliberately:

- **Ranks within sector.** Median P/E across these large caps runs 15.5x in
  Comm. & Media and 40.3x in Technology. An absolute rank mostly re-reports the
  sector mix and calls every miner cheap. Sectors with fewer than 8 graded
  members fall back to the whole universe.
- **Refuses negative denominators.** A loss-making company has no P/E, not a low
  one. Ranking −3x as cheaper than 8x would put every loss-maker at the top.
- **Floors implausible multiples.** Questrade reports a P/E of 0.15 for Perseus
  Mining while reporting no EPS — a $5.41 share implying $36 of earnings.
  Unfiltered it sorts first on a cheapest-first screen, the worst place for a
  bad number. See `RATIO_FLOOR` in `vite-plugins/db.js`.

Grades are **precomputed** into the `valuation` table, never derived per query:
a percentile computed over the current filter would mean "cheap among what you
happen to be looking at", so filtering to Mining would regrade every miner.
Every multiple has market cap in the numerator, so a price refresh regrades
automatically.

Coverage is the honest limit — **714 of 2,018 graded, 254 on two or more
factors**, because P/S, P/B, P/FCF and EV/EBITDA all need an SEC filer. The
ungraded rows are TSX-only companies filing PDFs with SEDAR+, and the tooltip
says so rather than showing a bare dash.

**Refresh fundamentals** on the Screener runs the SEC sweep for the current cap
filter, then regrades. It is slow — one XBRL payload per company at SEC's
fair-use rate — and entirely separate from the Questrade price refresh.

## The debt load grade

The **Debt** column, beside Value, on the same A–F scale. **A is least
indebted**, so A is the desirable end of both columns and a row reads
consistently. Four factors: debt/equity, net debt/EBITDA, interest coverage and
current ratio — the last two inverted, since a high reading is healthy there.

Coverage is better than the value grade despite needing the same filings,
because every debt ratio divides one SEC figure by another from the same filing
in the same currency. There is no cross-source mixing, so nothing is suppressed
and no FX rate is involved.

Three deliberate refusals:

- **Banks and insurers are not graded at all**, and are marked `n/a` rather than
  left blank. XBRL does not tag deposits as debt, so every Canadian bank reports
  debt/equity at or near 0.00 — and they report no EBITDA, no meaningful current
  ratio, and no interest coverage, because interest is their revenue. Grading
  them ranks the most leveraged institutions in the country as the safest. That
  is an inversion, not a gap.
- **An unresolved debt tag is never read as zero debt.** The derived metrics sum
  debt as `(longTermDebt ?? 0) + (shortTermDebt ?? 0)`, so a company whose debt
  concept this mapping does not know scores as debt-free — the best possible
  grade. Across the 30 largest filers, 8 were affected: Canadian Pacific and
  Shopify tag no known debt concept, Coeur last tagged one in 2012, Brookfield
  Infrastructure in 2017, Franco-Nevada in 2019. TC Energy still tags
  `LongTermDebt`, but at $2.8B against roughly $50B of borrowings. `assessDebt()`
  in `metrics.js` dates the debt figure and suppresses everything derived from it
  when it is missing or stale — including net debt, which removes those companies
  from EV/EBITDA in the value grade too.
- **Alarms are gated on actually being levered.** Interest coverage goes negative
  whenever operating income does, and 56 of the 79 companies with negative
  coverage carry almost no debt — they are loss-making explorers, not debt
  risks.

The **!** beside a letter is an absolute threshold breached, independent of the
ranking: net debt over 5x EBITDA, debt over 3x equity, interest barely covered
while levered, or current assets under half current liabilities. It exists
because the grade is sector-relative and a sector can be uniformly over-levered.
Enbridge is the clean case — an F against pipelines *and* an absolute flag at
6.3x EBITDA. Canadian Pacific is the opposite: an A on leverage with a liquidity
flag.

Caveats worth keeping in mind, which the tooltips repeat:

- **Debt-free is not the same as safe.** 97 of 177 miners show debt/equity under
  0.05, which is genuine — exploration juniors are equity-financed. A pre-revenue
  explorer with no debt still has to raise or die.
- **REITs get thin grades.** Real Estate averages 1.3 factors, because IFRS
  investment-property presentation has no current/non-current split.

## Rate limiting

Questrade caps market-data calls at **20 requests/second and 15,000/hour** (the
hourly figure is confirmed by the `x-ratelimit-remaining` header it returns).
The TSX 60 view alone fires ~60 candle requests, so throttling is enforced in
the dev-server proxy rather than in the browser: every request funnels through
one place, so the limit holds regardless of how many components, tabs or
reloads are active.

The limiter runs at 12 req/s and 13,000/hour, spacing request *starts* without
serialising the requests themselves. It reads `x-ratelimit-remaining` and idles
when the budget runs low, and on a 429 it honours `Retry-After` /
`x-ratelimit-reset`, backs off, and retries once.

Measured: 30 concurrent requests with no client-side spacing completed at
11.8 req/s, peaking at 14 in any one-second window, with zero 429s.

Two related hazards the proxy also handles:

- **Refresh stampede.** Refresh tokens are single-use, so concurrent refreshes
  defeat themselves — the first consumes the token and the rest get HTTP 400.
  A cold or expired session plus a 60-request view produced exactly that, one
  success and the rest 503. Refresh is now single-flight: all callers await the
  same exchange.
- **Upstream hangs.** Calls carry a 25s timeout so a slow request fails with an
  explanation instead of holding the connection until the browser gives up.

## Architecture

```
src/
  api/
    http.js       fetch wrapper: timeouts, typed errors, TTL cache, request dedup
    sec.js        SEC EDGAR endpoints (ticker index, submissions, companyfacts)
    facts.js      XBRL normalization — the hard part, see below
  analysis/
    metrics.js    THE METRIC CATALOG — edit this to change what the app tracks
    format.js     display formatting; null always renders as an em dash
  stores/         watchlist, persisted to localStorage
  views/          route components; StockView loads once and provides to its tabs
```

### Why `facts.js` is not trivial

Raw XBRL is not a time series, and four things will silently produce wrong
numbers if unhandled. All four are handled, and each has a regression-worthy
real-world example:

1. **Restatements.** The same fiscal period is re-reported across later
   filings; companyfacts returns every version. Apple's FY2021 revenue appears
   21 times. The most recently *filed* value wins.

2. **Mixed durations.** Quarterly, year-to-date, and annual figures share one
   array, distinguishable only by the gap between `start` and `end`.

3. **YTD reporting and the missing Q4.** Cash-flow items are reported
   cumulatively in 10-Qs (3mo → 6mo → 9mo), so filtering for ~90-day spans finds
   only Q1 of each year. And **no 10-Q ever contains Q4** — it exists only as
   (fiscal year − first nine months). Discrete quarters are therefore derived by
   differencing cumulative figures, and a trailing-twelve-month figure is
   rejected unless its four quarters form a genuinely contiguous year.

4. **Abandoned tags.** A tag existing does not mean it is current. Uber tagged
   `RevenueFromContractWithCustomerExcludingAssessedTax` four times in 2018 and
   has reported revenue under `Revenues` ever since; JPMorgan's quarterly
   `Revenues` series is perfectly contiguous and ends in 2014. Tag selection
   prefers catalog priority *among tags still being reported*.

Metrics return `null` — rendered `—` — rather than a plausible-looking number
whenever an input is missing or the ratio is meaningless (negative equity, a
bank with no cost of revenue). A blank is recoverable; a wrong number is not.

## Adding or changing a metric

Everything shown is declared in `src/analysis/metrics.js`, not computed inside
components.

- **Base metric** (straight from a filing): add to `BASE_METRICS` with a `tags`
  priority list — companies tag the same concept differently, so list the
  variants you have seen, most specific first.
- **Derived metric** (a ratio or combination): add to `DERIVED_METRICS` with a
  `compute(values)` function. Guard your inputs and return `null` when the
  result would be misleading.

The **Raw data** tab lists every XBRL fact the company has ever filed —
searchable, with the full datapoint history and source accession number for each
— so anything the catalog omits is still reachable.
