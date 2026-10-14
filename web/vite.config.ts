import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const API = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { '/api': { target: API, changeOrigin: true } },
    // Many engineers build feature routes in parallel: an unfinished route file must not cover the
    // whole app with the error overlay (it is skipped by src/lib/routes.ts; errors stay in the console).
    hmr: { overlay: false },
  },
  // built assets under /static: '/assets/*' is an app route (asset management)
  build: { chunkSizeWarningLimit: 1500, assetsDir: 'static' },
})
