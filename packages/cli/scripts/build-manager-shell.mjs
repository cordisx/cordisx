import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
await build({
  entryPoints: [fileURLToPath(new URL('src/independent-manager/shell.tsx', root))],
  outfile: fileURLToPath(new URL('dist/assets/manager/manager-shell.js', root)),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.svg': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
})
