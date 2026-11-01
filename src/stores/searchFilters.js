/** Which security categories the search shows, remembered across sessions. */
import { reactive, watch } from 'vue'
import { CATEGORIES, DEFAULT_CATEGORIES } from '../api/classify.js'

const KEY = 'take-stock:search-categories'
const VALID = new Set(CATEGORIES.map((c) => c.id))

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    // Drop unknown ids so a renamed category can't wedge the filter.
    if (Array.isArray(saved)) return saved.filter((id) => VALID.has(id))
  } catch {
    /* fall through to defaults */
  }
  return [...DEFAULT_CATEGORIES]
}

export const selectedCategories = reactive(load())

watch(selectedCategories, (v) => localStorage.setItem(KEY, JSON.stringify([...v])), { deep: true })

export function toggleCategory(id) {
  const i = selectedCategories.indexOf(id)
  if (i >= 0) selectedCategories.splice(i, 1)
  else selectedCategories.push(id)
}

export function setAllCategories(on) {
  selectedCategories.splice(0, selectedCategories.length)
  if (on) selectedCategories.push(...CATEGORIES.map((c) => c.id))
}

export const isAllSelected = () => selectedCategories.length === CATEGORIES.length
