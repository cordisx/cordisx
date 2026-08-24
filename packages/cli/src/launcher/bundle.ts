import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { CordisXConfig } from './config.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { ChannelManagerProjectionV1 } from '../renderer/channel-manager.js'

export interface BuildRendererBundleOptions {
  readonly providerBridgeToken?: string
  readonly agentHistoryBridgeToken?: string
  readonly profileId?: string
  readonly configBridgeToken?: string
  readonly serviceConfigBridgeToken?: string
  readonly generation?: string
  readonly pluginLifecycleBridgeToken?: string
  readonly pluginActivation?: CordisXPluginActivationRecordV1
  readonly initialRegistryEpoch?: number
  readonly channelManager?: ChannelManagerProjectionV1
  readonly permission?: {
    readonly profileId: string
    readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly bridgeToken?: string
  }
}

function importSpecifier(fromDirectory: string, absolutePath: string): string {
  const relative = path.relative(fromDirectory, absolutePath).replaceAll(path.sep, '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

async function readCordisXVersion(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    const packagePath = path.join(directory, 'package.json')
    try {
      const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === 'cordisx' && typeof manifest.version === 'string') return manifest.version
    } catch {
      // Keep walking until the owning CordisX package is found.
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error('CordisX package version could not be resolved')
    directory = parent
  }
}

async function readPluginReadme(entry: string): Promise<string | undefined> {
  try {
    await access(entry)
    return await readFile(path.join(path.dirname(entry), 'README.md'), 'utf8')
  } catch {
    return undefined
  }
}

/** Bundle the renderer host and every enabled plugin into one Cordis generation. */
export async function buildRendererBundle(config: CordisXConfig, options: BuildRendererBundleOptions = {}): Promise<string> {
  const enabled = config.plugins.filter(plugin => plugin.enabled)
  for (const plugin of enabled) await access(plugin.entry)
  const [version, readmes, pluginBundles] = await Promise.all([
    readCordisXVersion(),
    Promise.all(config.plugins.map(async plugin => plugin.readme ?? await readPluginReadme(plugin.entry))),
    Promise.all(enabled.map(async plugin => {
      const result = await build({
        entryPoints: [plugin.entry],
        bundle: true,
        format: 'iife',
        globalName: '__cordisxPluginModule',
        platform: 'browser',
        target: ['chrome120'],
        sourcemap: 'inline',
        loader: { '.svg': 'text', '.css': 'text' },
        write: false,
        logLevel: 'silent',
      })
      const output = result.outputFiles[0]
      if (output === undefined) throw new Error(`esbuild produced no renderer bundle for plugin ${plugin.id}`)
      return output.text
    })),
  ])

  const runtimeCandidates = [
    path.resolve(config.rootDir, 'packages/cli/src/renderer/runtime.ts'),
    path.resolve(config.rootDir, 'src/renderer/runtime.ts'),
    fileURLToPath(new URL('../renderer/runtime.ts', import.meta.url)),
    fileURLToPath(new URL('../renderer/runtime.js', import.meta.url)),
  ]
  let projectRuntime: string | undefined
  for (const candidate of runtimeCandidates) {
    projectRuntime = await access(candidate).then(() => candidate).catch(() => undefined)
    if (projectRuntime !== undefined) break
  }
  if (projectRuntime === undefined) throw new Error('CordisX renderer runtime could not be resolved')
  const imports = [
    `import { installCordisX } from ${JSON.stringify(importSpecifier(config.rootDir, projectRuntime))}`,
  ]
  const enabledIndexes = new Map(enabled.map((plugin, index) => [plugin.id, index]))
  const composition = `[${config.plugins.map((plugin, pluginIndex) => {
    const index = enabledIndexes.get(plugin.id)
    const moduleField = index === undefined ? '' : `, moduleFactory: (console) => { ${pluginBundles[index]}\nreturn __cordisxPluginModule }`
    const readme = readmes[pluginIndex]
    const readmeField = readme === undefined ? '' : `, readme: ${JSON.stringify(readme)}`
    const manifestField = plugin.manifest === undefined ? '' : `, manifest: ${JSON.stringify(plugin.manifest)}`
    const packageField = plugin.package === undefined ? '' : `, package: ${JSON.stringify(plugin.package)}`
    return `{ id: ${JSON.stringify(plugin.id)}, source: ${JSON.stringify(plugin.source ?? pathToFileURL(plugin.entry).href)}, enabled: ${plugin.enabled}, config: ${JSON.stringify(plugin.config)}, revision: ${plugin.revision ?? 0}${readmeField}${manifestField}${packageField}${moduleField} }`
  }).join(',')}]`
  const providers = config.providers.filter(provider => provider.enabled).map(provider => ({ id: provider.id, displayName: provider.displayName }))
  const permission = options.permission ?? { profileId: options.profileId ?? 'development', policies: [] }
  const metadata = `{ version: ${JSON.stringify(version)}, providers: ${JSON.stringify(providers)}, profileId: ${JSON.stringify(permission.profileId)}, permissionPolicies: ${JSON.stringify(permission.policies)}${options.generation === undefined ? '' : `, generation: ${JSON.stringify(options.generation)}`}${options.providerBridgeToken === undefined ? '' : `, providerBridgeToken: ${JSON.stringify(options.providerBridgeToken)}`}${options.agentHistoryBridgeToken === undefined ? '' : `, agentHistoryBridgeToken: ${JSON.stringify(options.agentHistoryBridgeToken)}`}${options.configBridgeToken === undefined ? '' : `, configBridgeToken: ${JSON.stringify(options.configBridgeToken)}`}${options.serviceConfigBridgeToken === undefined ? '' : `, serviceConfigBridgeToken: ${JSON.stringify(options.serviceConfigBridgeToken)}`}${options.pluginLifecycleBridgeToken === undefined ? '' : `, pluginLifecycleBridgeToken: ${JSON.stringify(options.pluginLifecycleBridgeToken)}`}${options.pluginActivation === undefined ? '' : `, pluginActivation: ${JSON.stringify(options.pluginActivation)}`}${options.initialRegistryEpoch === undefined ? '' : `, initialRegistryEpoch: ${JSON.stringify(options.initialRegistryEpoch)}`}${options.channelManager === undefined ? '' : `, channelManager: ${JSON.stringify(options.channelManager)}`}${permission.bridgeToken === undefined ? '' : `, permissionBridgeToken: ${JSON.stringify(permission.bridgeToken)}`} }`
  const source = `${imports.join('\n')}\nvoid installCordisX(${composition}, ${metadata}).catch(error => console.error('[cordisx] boot failed', error))\n`

  const result = await build({
    stdin: { contents: source, resolveDir: config.rootDir, sourcefile: 'cordisx-composition.ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: 'inline',
    loader: { '.svg': 'text', '.css': 'text' },
    write: false,
    logLevel: 'silent',
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error('esbuild produced no renderer bundle')
  return output.text
}
