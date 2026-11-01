import { copyFile } from 'node:fs/promises'
import { build } from 'esbuild'
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/adapter.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'eof',
})

await copyFile('dist/index.d.ts', 'dist/adapter.d.mts')
