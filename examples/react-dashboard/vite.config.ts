import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `npm run dev` proxies the API, so the app talks to the observer same-origin.
// Or build it and serve with: oadt --ui examples/react-dashboard/dist
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5176,
    proxy: { '/api': { target: process.env.OADT_API ?? 'http://127.0.0.1:4545', changeOrigin: true } },
  },
})
