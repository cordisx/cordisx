import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  type BuildRendererBundleOptions,
  buildRendererCompositionSource,
} from '../../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../../packages/cli/src/launcher/config.js'

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'connector-production-host-fixture.ts')

/** Build a temporary-only production composition with the fixed Host fixture. */
export async function buildConnectorProductionBundle(
  config: CordisXConfig,
  options: BuildRendererBundleOptions = {},
): Promise<string> {
  const composition = await buildRendererCompositionSource(config, options)
  const installCall = `installCordisX(${composition.pluginsSource}, ${composition.metadataSource})`
  const marker = composition.source.indexOf(installCall)
  if (marker < 0 || composition.source.indexOf(installCall, marker + installCall.length) >= 0) {
    throw new Error('production composition install call is unavailable or ambiguous')
  }
  const fixtureImport = `import { installConnectorProductionFixture } from ${JSON.stringify(fixturePath)}\n`
  const fixtureInstallCall = `${installCall.slice(0, -1)}, installConnectorProductionFixture)`
  const source = `${fixtureImport}${composition.source.slice(0, marker)}${fixtureInstallCall}${
    composition.source.slice(marker + installCall.length)
  }`
  const result = await build({
    stdin: { contents: source, resolveDir: config.rootDir, sourcefile: 'connector-production-smoke-composition.ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: 'inline',
    loader: { '.svg': 'text', '.css': 'text', '.png': 'dataurl' },
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error('connector production smoke bundle is unavailable')
  return output.text
}
