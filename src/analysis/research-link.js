/**
 * Outbound links: qualitative research, and a live quote.
 *
 * `udm=50` routes the query to Google's AI Mode, which returns a synthesised
 * answer with citations rather than ten blue links — useful for the qualitative
 * side of a decision (competitive position, management, recent news) that the
 * filings-derived metrics in this app deliberately do not attempt.
 */

const AI_MODE = 'https://www.google.com/search?udm=50&q='

/** "SHOP.TO" -> { root: "SHOP", exchange: "TSX" } */
function describeListing(symbol) {
  const s = String(symbol ?? '')
  const venture = s.endsWith('.VN')
  return {
    root: s.replace(/\.(TO|VN)$/, ''),
    exchange: venture ? 'TSX Venture' : 'TSX',
  }
}

/**
 * A prompt framed as investment due diligence.
 *
 * Deliberately asks for the bear case and for what would change the thesis:
 * a question phrased only as "should I invest" invites a confirmatory answer,
 * which is the opposite of useful when you are trying to decide.
 *
 * @param {{symbol: string, name?: string, sector?: string}} row
 */
export function researchQuery(row) {
  const { root, exchange } = describeListing(row.symbol)
  const name = row.name || root
  const sector = row.sector ? ` It operates in ${row.sector}.` : ''

  return (
    `I am evaluating ${name} (${root} on the ${exchange}) as a potential long-term investment.` +
    `${sector} ` +
    `What should I know before deciding? Cover recent financial performance and trends, ` +
    `competitive position and moat, management quality and capital allocation, balance sheet ` +
    `risks, valuation versus Canadian peers, dividend sustainability if it pays one, and any ` +
    `recent news, litigation or regulatory issues that matter. ` +
    `Give me the bear case as well as the bull case, and say what would most change the thesis.`
  )
}

/** Full AI Mode URL for a listing. */
export const researchUrl = (row) => AI_MODE + encodeURIComponent(researchQuery(row))

/**
 * Live quote on TMX Money, the exchange's own site.
 *
 * Exists because nothing in this app is live. Questrade candles are delayed
 * unless the account carries a real-time data subscription, and the smallest
 * candle offered here is five minutes — fine for reading the shape of a
 * session, useless for "where is it trading right now". Rather than imply a
 * freshness the data does not have, that question is handed to the venue.
 *
 * TMX rather than a US aggregator for the same reason the universe comes from
 * TMX: it is the listing exchange, so it covers TSXV juniors that Yahoo and
 * friends either miss or quote badly. Venture listings take a `:CV` suffix;
 * TSX ones are the bare root.
 */
export function liveQuoteUrl(symbol) {
  const { root } = describeListing(symbol)
  const venture = String(symbol ?? '').endsWith('.VN')
  return `https://money.tmx.com/en/quote/${encodeURIComponent(root)}${venture ? ':CV' : ''}`
}
