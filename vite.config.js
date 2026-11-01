import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { questradePlugin } from './vite-plugins/questrade.js'

// SEC requires every automated request to declare a contact address.
// Override with SEC_USER_AGENT in .env.local — see README.
const DEFAULT_UA = 'take-stock/0.1 (fourfivesixcdn@gmail.com)'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const ua = env.SEC_USER_AGENT || DEFAULT_UA

  // Browsers can't set User-Agent, and www.sec.gov sends no CORS headers,
  // so all SEC traffic goes through the dev server.
  const secProxy = (target) => ({
    target,
    changeOrigin: true,
    headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' },
    rewrite: (path) => path.replace(/^\/sec-(data|www)/, ''),
  })

  return {
    // Questrade is a plugin rather than a proxy entry: it has to hold an OAuth
    // session and rotate a single-use refresh token, which a static proxy can't.
    plugins: [vue(), questradePlugin(env)],
    server: {
      proxy: {
        '/sec-data': secProxy('https://data.sec.gov'),
        '/sec-www': secProxy('https://www.sec.gov'),
      },
    },
  }
})
