// Bundles the server (and the shared contract from ../windows/src/shared) into dist/index.js.
// npm packages stay external and are installed in the runtime image.
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
})
cpSync('migrations', 'dist/migrations', { recursive: true })
