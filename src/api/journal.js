/**
 * Research journal — notes, reminders and custom groups.
 *
 * All of it lives in the local SQLite database. This is the only data in the
 * app that cannot be refetched from somewhere.
 */
import { getJson } from './http.js'

async function send(path, method, payload) {
  const res = await fetch(`/api/db${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`)
  return data
}

// --- notes ---

export const fetchNotes = (symbol) =>
  getJson(`/api/db/notes?symbol=${encodeURIComponent(symbol)}`, { ttl: 0 })

export const fetchAllNotes = (q = '') =>
  getJson(`/api/db/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`, { ttl: 0 })

export const fetchNoteCounts = () => getJson('/api/db/notes/counts', { ttl: 0 })

export const createNote = (note) => send('/notes', 'POST', note)
export const editNote = (id, patch) => send('/notes', 'PATCH', { id, ...patch })
export const removeNote = (id) => send(`/notes?id=${id}`, 'DELETE')

/** The kinds a note can be tagged with, and how they read in the UI. */
export const NOTE_KINDS = [
  { id: 'thesis', label: 'Thesis', hint: 'Why this is worth owning' },
  { id: 'risk', label: 'Risk', hint: 'What could break it' },
  { id: 'catalyst', label: 'Catalyst', hint: 'Event that could move it' },
  { id: 'valuation', label: 'Valuation', hint: 'What it is worth, and why' },
  { id: 'question', label: 'Question', hint: 'Still to find out' },
  { id: 'note', label: 'Note', hint: 'Anything else' },
]

// --- reminders ---

export const fetchReminders = (symbol) =>
  getJson(`/api/db/reminders${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`, { ttl: 0 })

export const fetchDueReminders = () => getJson('/api/db/reminders/due', { ttl: 0 })
export const createReminder = (reminder) => send('/reminders', 'POST', reminder)
export const completeReminder = (id) => send('/reminders', 'PATCH', { id })
export const removeReminder = (id) => send(`/reminders?id=${id}`, 'DELETE')

/** Horizons that match how you actually think about revisiting a position. */
export const REMINDER_PRESETS = [
  { label: '1 week', days: 7 },
  { label: '1 month', days: 30 },
  { label: 'Next quarter', days: 91 },
  { label: '6 months', days: 182 },
  { label: '1 year', days: 365 },
]

export const dueDateFrom = (days) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

// --- groups ---

export const fetchAnnotations = () => getJson('/api/db/annotations', { ttl: 0 })

export const fetchGroups = () => getJson('/api/db/groups', { ttl: 0 })
export const fetchGroupMembers = () => getJson('/api/db/groups/members', { ttl: 0 })
export const createGroup = (group) => send('/groups', 'POST', group)
export const removeGroup = (id) => send(`/groups?id=${id}`, 'DELETE')
export const addSymbolToGroup = (groupId, symbol) => send('/groups', 'POST', { groupId, symbol })
export const removeSymbolFromGroup = (groupId, symbol) =>
  send(`/groups?id=${groupId}&symbol=${encodeURIComponent(symbol)}`, 'DELETE')
