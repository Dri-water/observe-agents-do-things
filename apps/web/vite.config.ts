import { defineConfig } from 'vite'

// During `npm run dev`, the API runs separately (default :4545) and Vite proxies to it.
const api = process.env.OADT_API ?? 'http://127.0.0.1:4545'

export default defineConfig({
  base: './',
  server: {
    port: 5175,
    proxy: {
      '/api': { target: api, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
})
