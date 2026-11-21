import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Produce the exact Host Manager stylesheet without adding a second styling implementation. */
export async function buildManagerStyles(output = path.join(root, 'dist/assets/manager/manager-host.css')) {
  const result = await build({
    stdin: {
      contents: `export { REACT_MANAGER_STYLES } from './src/renderer/manager/styles.ts';
export { EMPTY_STATE_ILLUSTRATION_STYLES, EMPTY_STATE_STYLES } from './src/renderer/host-ui/empty-state-styles.ts';`,
      resolveDir: root,
      loader: 'ts',
    },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    loader: { '.css': 'text', '.svg': 'text', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
  const { REACT_MANAGER_STYLES, EMPTY_STATE_ILLUSTRATION_STYLES, EMPTY_STATE_STYLES } = await import(moduleUrl)
  if (
    typeof REACT_MANAGER_STYLES !== 'string' || typeof EMPTY_STATE_ILLUSTRATION_STYLES !== 'string'
    || typeof EMPTY_STATE_STYLES !== 'string'
  ) throw new Error('Host Manager stylesheet is unavailable')
  const pageHeaderActions = await readFile(path.join(root, 'src/renderer/page-header-actions.css'), 'utf8')
  const standalone = await readFile(path.join(root, 'src/renderer/manager/manager-standalone.css'), 'utf8')
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(
    output,
    `${REACT_MANAGER_STYLES}\n${pageHeaderActions}\n${EMPTY_STATE_ILLUSTRATION_STYLES}\n${EMPTY_STATE_STYLES}\n${standalone}`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildManagerStyles()
}
