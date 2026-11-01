/**
 * Per-symbol annotations — notes, reminders, lists and tags — for row badges.
 *
 * Kept separate from the universe query on purpose. The note count used to be a
 * subquery inside it, which meant a badge was only ever as fresh as the last
 * full page load: write a note, return to the Screener, and it was missing
 * until you reloaded. This is a small payload that can be refetched after any
 * write without re-running the heavy universe query.
 */
import { reactive } from 'vue'
import { getJson } from '../api/http.js'

const EMPTY = Object.freeze({ notes: 0, reminders: 0, overdue: 0, lists: [], tags: [] })

export const annotations = reactive({ bySymbol: {}, loaded: false })

export async function loadAnnotations() {
  try {
    annotations.bySymbol = await getJson('/api/db/annotations', { ttl: 0 })
    annotations.loaded = true
  } catch {
    /* database not ready — badges are decoration, never blocking */
  }
}

export const annotationsFor = (symbol) => annotations.bySymbol[symbol] ?? EMPTY

/** Call after any note/reminder/list/tag write so badges update in place. */
export const refreshAnnotations = loadAnnotations
