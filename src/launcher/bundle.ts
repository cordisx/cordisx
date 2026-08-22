import { access } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import type { CordisXConfig } from './config.js'

function importSpecifier(fromDirectory: string, absolutePath: string): string {
  const relative = path.relative(fromDirectory, absolutePath).replaceAll(path.sep, '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

/** Bundle the renderer host and every enabled plugin into one Cordis generation. */
export async function buildRendererBundle(config: CordisXConfig): Promise<string> {
  const enabled = config.plugins.filter(plugin => plugin.enabled)
  for (const plugin of enabled) await access(plugin.entry)

  const runtimePath = path.resolve(config.rootDir, 'src/renderer/runtime.ts')
  const projectRuntime = await access(runtimePath).then(() => runtimePath).catch(() => {
    return new URL('../renderer/runtime.js', import.meta.url).pathname
  })
  const imports = [
    `import { installCordisX } from ${JSON.stringify(importSpecifier(config.rootDir, projectRuntime))}`,
    ...enabled.map((plugin, index) => `import * as plugin${index} from ${JSON.stringify(importSpecifier(config.rootDir, plugin.entry))}`),
  ]
  const rows = enabled.map((plugin, index) => ({
    id: plugin.id,
    moduleExpression: `plugin${index}`,
    config: plugin.config,
  }))
  const composition = `[${rows.map(row => `{ id: ${JSON.stringify(row.id)}, module: ${row.moduleExpression}, config: ${JSON.stringify(row.config)} }`).join(',')}]`
  const source = `${imports.join('\n')}\nvoid installCordisX(${composition}).catch(error => console.error('[cordisx] boot failed', error))\n`

  const result = await build({
    stdin: { contents: source, resolveDir: config.rootDir, sourcefile: 'cordisx-composition.ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: 'inline',
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error('esbuild produced no renderer bundle')
  return output.text
}
