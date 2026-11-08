import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['node:sqlite'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Stdio MCP server the Claude / Codex CLIs use to read the timeline during chat.
          'mcp-server': resolve(__dirname, 'src/main/chat/mcp-server.ts'),
        },
      },
    },
  },
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    plugins: [
      react(),
      {
        // Dev needs inline scripts (React refresh preamble); the production bundle has none,
        // so ship a CSP without 'unsafe-inline' for scripts.
        name: 'dayflow-strict-csp',
        apply: 'build',
        transformIndexHtml: (html: string) => html.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'"),
      },
    ],
  },
})
