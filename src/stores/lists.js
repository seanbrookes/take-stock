/**
 * Watch lists — a single concept, backed by SQLite.
 *
 * There were briefly two: a star writing to localStorage, and named groups in
 * the database. Two places to record "I care about this" is one too many, so
 * the star is now just a shortcut for membership of a list called "Watchlist".
 * Anything already starred in localStorage is migrated once, then that store is
 * retired.
 */
import { reactive, computed } from 'vue'
import { refreshAnnotations } from './annotations.js'
import {
  fetchGroups,
  fetchGroupMembers,
  createGroup,
  addSymbolToGroup,
  removeSymbolFromGroup,
  removeGroup,
} from '../api/journal.js'

export const DEFAULT_LIST = 'Watchlist'
const LEGACY_KEY = 'take-stock:watchlist'
const MIGRATED_KEY = 'take-stock:watchlist-migrated'

export const state = reactive({
  groups: [],
  /** symbol -> [{id, name, colour}] */
  bySymbol: {},
  loaded: false,
  error: null,
})

export async function loadLists() {
  try {
    const [g, m] = await Promise.all([fetchGroups(), fetchGroupMembers()])
    state.groups = g.groups
    const map = {}
    for (const row of m.members) {
      ;(map[row.symbol] ??= []).push({ id: row.id, name: row.name, colour: row.colour })
    }
    state.bySymbol = map
    state.loaded = true
    state.error = null
    // Badges elsewhere in the app depend on the same data.
    refreshAnnotations()
  } catch (err) {
    state.error = err
  }
}

/** Create the default list on demand rather than seeding an empty database. */
async function ensureDefault() {
  const existing = state.groups.find((g) => g.name === DEFAULT_LIST)
  if (existing) return existing
  const created = await createGroup({ name: DEFAULT_LIST }).catch(() => null)
  await loadLists()
  return created ?? state.groups.find((g) => g.name === DEFAULT_LIST)
}

export const listsFor = (symbol) => state.bySymbol[symbol] ?? []

export const isInList = (symbol, groupId) =>
  listsFor(symbol).some((g) => String(g.id) === String(groupId))

export const isWatched = (symbol) =>
  listsFor(symbol).some((g) => g.name === DEFAULT_LIST)

/** Add-only. A field labelled "add tags" must never silently remove one. */
export async function addToList(groupId, symbol) {
  if (!isInList(symbol, groupId)) {
    await addSymbolToGroup(groupId, symbol)
    await loadLists()
  }
}

export async function toggleList(groupId, symbol) {
  if (isInList(symbol, groupId)) await removeSymbolFromGroup(groupId, symbol)
  else await addSymbolToGroup(groupId, symbol)
  await loadLists()
}

/** The star: membership of the default list, created if this is the first use. */
export async function toggleWatch(symbol) {
  const group = await ensureDefault()
  if (!group) return
  await toggleList(group.id, symbol)
}

export const listsOnly = computed(() => state.groups.filter((g) => g.kind !== 'tag'))
export const tagsOnly = computed(() => state.groups.filter((g) => g.kind === 'tag'))

export async function createList(name, symbol = null, kind = 'list') {
  const group = await createGroup({ name, kind })
  if (symbol) await addSymbolToGroup(group.id, symbol)
  await loadLists()
  return group
}

export async function deleteList(id) {
  await removeGroup(id)
  await loadLists()
}

/** Symbols in a named list, for the watchlist view. */
export const membersOf = (groupId) =>
  Object.entries(state.bySymbol)
    .filter(([, groups]) => groups.some((g) => String(g.id) === String(groupId)))
    .map(([symbol]) => symbol)

export const defaultList = computed(() => state.groups.find((g) => g.name === DEFAULT_LIST) ?? null)

/**
 * One-time move of the old localStorage watchlist into the database. Kept
 * deliberately simple: it runs once, and failure is not worth blocking on.
 */
export async function migrateLegacyWatchlist() {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]')
    if (!Array.isArray(legacy) || !legacy.length) {
      localStorage.setItem(MIGRATED_KEY, '1')
      return
    }
    const group = await ensureDefault()
    if (!group) return
    for (const row of legacy) {
      if (row?.symbol) await addSymbolToGroup(group.id, row.symbol)
    }
    localStorage.setItem(MIGRATED_KEY, '1')
    await loadLists()
    console.info(`[take-stock] migrated ${legacy.length} starred symbols into "${DEFAULT_LIST}"`)
  } catch {
    /* the database may not be ready; the star still works without migration */
  }
}
