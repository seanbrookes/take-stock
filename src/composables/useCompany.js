import { inject } from 'vue'

/**
 * StockView loads the company once (companyfacts alone can be several MB) and
 * provides it to the tab routes. Children read it through this hook instead of
 * refetching on every tab switch.
 */
export const COMPANY_KEY = Symbol('company')

export function useCompany() {
  const company = inject(COMPANY_KEY, null)
  if (!company) throw new Error('useCompany() must be used inside a StockView route')
  return company
}
