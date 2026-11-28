import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
await build({
  entryPoints: [fileURLToPath(new URL('src/independent-manager/standalone-entry.ts', root))],
  outfile: fileURLToPath(new URL('dist/assets/manager/manager-standalone.js', root)),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  preserveSymlinks: true,
  loader: { '.svg': 'text', '.css': 'text', '.png': 'dataurl' },
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
