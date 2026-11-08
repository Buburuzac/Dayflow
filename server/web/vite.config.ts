import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dashboard is served by the Dayflow Sync Server from server/web/dist at "/", same-origin.
// In dev, /api is proxied to a locally running server.
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    // The shared contract lives in windows/src/shared, outside this package.
    fs: { allow: ['..', '../../windows/src/shared'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8790', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as never)
