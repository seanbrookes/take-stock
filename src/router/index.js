import { createRouter, createWebHistory } from 'vue-router'

// Views are lazy-loaded so the raw-data explorer (the heaviest screen)
// doesn't sit in the initial bundle.
const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
    meta: { title: 'Watchlist', wide: true },
  },
  {
    path: '/tsx60',
    name: 'tsx60',
    component: () => import('../views/Tsx60View.vue'),
    meta: { title: 'TSX 60', wide: true },
  },
  {
    path: '/screener',
    name: 'screener',
    component: () => import('../views/ScreenerView.vue'),
    meta: { title: 'Screener', wide: true },
  },
  {
    path: '/sectors',
    name: 'sectors',
    component: () => import('../views/SectorsView.vue'),
    meta: { title: 'Sectors' },
  },
  {
    path: '/stock/:symbol',
    component: () => import('../views/StockView.vue'),
    props: true,
    meta: { wide: true },
    children: [
      {
        path: '',
        name: 'stock',
        component: () => import('../views/stock/StockOverview.vue'),
        meta: { tab: 'Overview' },
      },
      {
        path: 'prices',
        name: 'stock-prices',
        component: () => import('../views/stock/StockPrices.vue'),
        meta: { tab: 'Prices' },
      },
      {
        path: 'notes',
        name: 'stock-notes',
        component: () => import('../views/stock/StockNotes.vue'),
        meta: { tab: 'Notes' },
      },
      {
        path: 'financials',
        name: 'stock-financials',
        component: () => import('../views/stock/StockFinancials.vue'),
        meta: { tab: 'Financials' },
      },
      {
        path: 'raw',
        name: 'stock-raw',
        component: () => import('../views/stock/StockRawData.vue'),
        meta: { tab: 'Raw data' },
      },
    ],
  },
  {
    path: '/journal',
    name: 'journal',
    component: () => import('../views/JournalView.vue'),
    meta: { title: 'Journal' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { title: 'Settings' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (to, from, saved) => saved ?? { top: 0 },
})

router.afterEach((to) => {
  const symbol = to.params.symbol
  const title = symbol ? String(symbol).toUpperCase() : to.meta.title
  document.title = title ? `${title} · take-stock` : 'take-stock'
})

export default router
