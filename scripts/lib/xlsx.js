import zlib from 'node:zlib'
import fs from 'node:fs'

/**
 * Minimal .xlsx reader — no dependencies.
 *
 * An .xlsx is a ZIP of XML parts, and Node ships everything needed to read one
 * (zlib for the entries, string work for the XML). Pulling in a spreadsheet
 * library for what is ultimately "read a table of strings and numbers" is not
 * a trade worth making for this project.
 *
 * Scope: enough to read TMX's issuer reports — shared strings, inline strings,
 * numbers, multiple sheets, sparse rows. It does not evaluate formulas, apply
 * number formats, or handle ZIP64.
 */

/** Parse the ZIP central directory and inflate every entry. */
function readZip(buf) {
  const EOCD_SIG = 0x06054b50
  let eocd = -1
  // The end-of-central-directory record lives at the tail, after an optional
  // comment, so it has to be found by scanning backwards.
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end-of-central-directory record)')

  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const files = new Map()

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    // The local header repeats the name/extra with different lengths, so the
    // data offset must be computed from the local header, not the central one.
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)

    files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw))
    off += 46 + nameLen + extraLen + commentLen
  }
  return files
}

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')

const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, ''))

/** "A" -> 0, "Z" -> 25, "AA" -> 26 */
function columnIndex(ref) {
  let n = 0
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/**
 * @param {string} filePath
 * @returns {Array<{name: string, rows: Array<Array<string|number|null>>}>}
 */
export function readXlsx(filePath) {
  const files = readZip(fs.readFileSync(filePath))

  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  // Concatenate the <t> runs inside each <si>; rich text splits a single
  // string across several runs.
  const shared = [...sharedXml.matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => decodeEntities(t[1])).join(''),
  )

  // Sheet order and names come from the workbook; the r:id maps to a file.
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const relTargets = new Map(
    [...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [
      m[1],
      m[2].replace(/^\/?xl\//, ''),
    ]),
  )

  const sheets = []
  for (const m of workbook.matchAll(/<sheet[^>]*\/>/g)) {
    const tag = m[0]
    const name = decodeEntities(/name="([^"]*)"/.exec(tag)?.[1] ?? 'Sheet')
    const rid = /r:id="([^"]*)"/.exec(tag)?.[1]
    const target = relTargets.get(rid)
    const entry = target && (files.get(`xl/${target}`) ?? files.get(target))
    if (!entry) continue

    const xml = entry.toString('utf8')
    const rows = []
    for (const rowMatch of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
      const cells = []
      // Match the cell envelope, then pull values out of its body. A formula
      // cell is <c><f>SUM(..)</f><v>42</v></c> — requiring <v> to follow <c>
      // directly would skip every computed cell, which is how the issuer-count
      // totals in the TMX preamble went missing.
      for (const c of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
        const attrs = c[1]
        const body = c[2] ?? ''
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1]
        if (!ref) continue
        const idx = columnIndex(ref)
        const type = /t="([^"]+)"/.exec(attrs)?.[1]

        const inline = /<is>(.*?)<\/is>/s.exec(body)?.[1]
        const raw = /<v>(.*?)<\/v>/s.exec(body)?.[1]

        let value = null
        if (inline != null) value = stripTags(inline)
        else if (raw != null) {
          if (type === 's') value = shared[Number(raw)] ?? null
          else if (type === 'str' || type === 'e') value = decodeEntities(raw)
          else {
            const num = Number(raw)
            value = Number.isFinite(num) ? num : decodeEntities(raw)
          }
        }
        // Position by column letter — rows are sparse, so sequential order lies.
        cells[idx] = value
      }
      rows.push(cells)
    }
    sheets.push({ name, rows })
  }
  return sheets
}
