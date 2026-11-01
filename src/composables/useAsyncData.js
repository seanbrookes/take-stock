import { ref, shallowRef, watchEffect, onScopeDispose } from 'vue'

/**
 * Run an async loader whose inputs are reactive, with the usual guarantees:
 * stale responses never overwrite fresh ones, in-flight requests abort when
 * inputs change or the component unmounts, and errors surface as state.
 *
 * @param {(signal: AbortSignal) => Promise<T>} loader
 * @template T
 */
export function useAsyncData(loader, { immediate = true } = {}) {
  const data = shallowRef(null)
  const error = shallowRef(null)
  const loading = ref(false)

  let controller = null
  let generation = 0

  const run = async () => {
    controller?.abort()
    controller = new AbortController()
    const mine = ++generation
    const { signal } = controller

    loading.value = true
    error.value = null

    try {
      const value = await loader(signal)
      if (mine !== generation) return // a newer call already won
      data.value = value
    } catch (err) {
      if (mine !== generation || signal.aborted) return
      error.value = err
      data.value = null
    } finally {
      if (mine === generation) loading.value = false
    }
  }

  if (immediate) watchEffect(run)
  onScopeDispose(() => controller?.abort())

  return { data, error, loading, refresh: run }
}
