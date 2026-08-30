import { createHash } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import type { CordisXConfig, CordisXConfigPlugin } from './config.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { HomeConfigIconThemePreference } from '../config/home-config.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { ChannelManagerProjectionV1 } from '../renderer/channel-manager.js'
import {
  assertNoPrivateReactBundle,
  cordisXReactVirtualModules,
} from './react-virtual-modules.js'

export interface BuildRendererBundleOptions {
  /** Use only explicit CordisX Playground seats; never inspect Codex DOM. */
  readonly playground?: boolean
  readonly providerBridgeToken?: string
  readonly agentHistoryBridgeToken?: string
  readonly profileId?: string
  readonly appId?: string
  readonly iconThemePreference?: HomeConfigIconThemePreference
  readonly iconThemePreferenceBridgeToken?: string
  readonly configBridgeToken?: string
  readonly serviceConfigBridgeToken?: string
  readonly channelCredentialBridgeToken?: string
  readonly channelActionsBridgeToken?: string
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

export interface RendererCompositionSource {
  /** An ESM composition module. The caller chooses whether boot is awaited. */
  readonly source: string
  /** Files outside the ESM graph which must invalidate the composition. */
  readonly watchFiles: readonly string[]
}

function bundledArtifactGeneration(plugin: CordisXConfigPlugin, moduleSource: string): string {
  const digest = createHash('sha256')
    .update('cordisx.bundled-plugin-artifact.v1\0')
    .update(plugin.id)
    .update('\0')
    .update(moduleSource)
    .update('\0')
    .update(JSON.stringify({ config: plugin.config, manifest: plugin.manifest ?? null }))
    .digest('base64url')
  // This is an opaque, domain-separated generation token, not the package's
  // raw digest. Paths and source principals are never embedded or projected.
  return `artifact_${digest.slice(0, 40)}`
}

export interface RendererCompositionSourceOptions {
  /** Override the runtime import for development transports such as Vite. */
  readonly runtimeImport?: string
  /** Export the awaited runtime handle instead of fire-and-forget production boot. */
  readonly awaitBoot?: boolean
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

interface PluginReadmes {
  readonly default?: string
  readonly localized: Readonly<Record<string, string>>
  readonly files: readonly string[]
}

const README_FILE = /^README(?:\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*))?\.(?:md|markdown)$/iu

async function readPluginReadmesIn(directory: string): Promise<PluginReadmes> {
  try {
    const names = await readdir(directory)
    const matches = names.flatMap(name => {
      const match = README_FILE.exec(name)
      return match === null ? [] : [{ name, locale: match[1]?.toLocaleLowerCase() }]
    })
    const values = await Promise.all(matches.map(async ({ name, locale }) => ({
      file: path.join(directory, name),
      locale,
      source: await readFile(path.join(directory, name), 'utf8'),
    })))
    const fallback = values.find(value => value.locale === undefined)
    return {
      ...(fallback === undefined ? {} : { default: fallback.source }),
      localized: Object.fromEntries(values.flatMap(value => value.locale === undefined ? [] : [[value.locale, value.source]])),
      files: values.map(value => value.file),
    }
  } catch {
    return { localized: {}, files: [] }
  }
}

async function readPluginReadmes(entry: string): Promise<PluginReadmes> {
  const entryDirectory = path.dirname(entry)
  let directory = entryDirectory
  while (true) {
    const readmes = await readPluginReadmesIn(directory)
    if (directory === entryDirectory && readmes.files.length > 0) return readmes
    const packageRoot = await access(path.join(directory, 'package.json')).then(() => true).catch(() => false)
    if (packageRoot) return readmes
    const parent = path.dirname(directory)
    if (parent === directory) return { localized: {}, files: [] }
    directory = parent
  }
}

/**
 * Build the shared renderer composition module.
 *
 * Production esbuild and the Vite Playground both consume this source so the
 * development page cannot drift into a copied Host implementation.
 */
export async function buildRendererCompositionSource(
  config: CordisXConfig,
  options: BuildRendererBundleOptions = {},
  sourceOptions: RendererCompositionSourceOptions = {},
): Promise<RendererCompositionSource> {
  const enabled = config.plugins.filter(plugin => plugin.enabled)
  for (const plugin of enabled) await access(plugin.entry)
  const [version, readmes, pluginBundles] = await Promise.all([
    readCordisXVersion(),
    Promise.all(config.plugins.map(async plugin => {
      if (plugin.readme !== undefined) return { default: plugin.readme, localized: {}, files: [] } satisfies PluginReadmes
      return await readPluginReadmes(plugin.entry)
    })),
    Promise.all(enabled.map(async plugin => {
      if (plugin.moduleFactorySource !== undefined) return {
        source: plugin.moduleFactorySource,
        artifactGeneration: bundledArtifactGeneration(plugin, plugin.moduleFactorySource),
      }
      const result = await build({
        entryPoints: [plugin.entry],
        bundle: true,
        format: 'iife',
        globalName: '__cordisxPluginModule',
        platform: 'browser',
        target: ['chrome120'],
        sourcemap: 'inline',
        loader: { '.svg': 'text', '.css': 'text', '.png': 'dataurl' },
        jsx: 'automatic',
        jsxImportSource: 'cordisx/react',
        metafile: true,
        plugins: [cordisXReactVirtualModules()],
        write: false,
        logLevel: 'silent',
      })
      if (result.metafile === undefined) throw new Error(`esbuild produced no dependency metadata for plugin ${plugin.id}`)
      assertNoPrivateReactBundle(result.metafile, `plugin ${plugin.id}`)
      const output = result.outputFiles[0]
      if (output === undefined) throw new Error(`esbuild produced no renderer bundle for plugin ${plugin.id}`)
      return {
        source: output.text,
        artifactGeneration: bundledArtifactGeneration(plugin, output.text),
      }
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
  const runtimeImport = sourceOptions.runtimeImport ?? importSpecifier(config.rootDir, projectRuntime)
  const imports = [`import { installCordisX } from ${JSON.stringify(runtimeImport)}`]
  const enabledIndexes = new Map(enabled.map((plugin, index) => [plugin.id, index]))
  const composition = `[${config.plugins.map((plugin, pluginIndex) => {
    const index = enabledIndexes.get(plugin.id)
    const moduleField = index === undefined ? '' : `, moduleFactory: (console) => { ${pluginBundles[index]!.source}\nreturn __cordisxPluginModule }`
    const artifactGenerationField = index === undefined || plugin.package !== undefined
      ? ''
      : `, artifactGeneration: ${JSON.stringify(pluginBundles[index]!.artifactGeneration)}`
    const readme = readmes[pluginIndex]
    const readmeField = readme?.default === undefined ? '' : `, readme: ${JSON.stringify(readme.default)}`
    const localizedReadmes = readme === undefined ? {} : {
      ...(readme.default === undefined ? {} : { default: readme.default }),
      ...readme.localized,
    }
    const readmesField = Object.keys(localizedReadmes).length === 0 ? '' : `, readmes: ${JSON.stringify(localizedReadmes)}`
    const manifestField = plugin.manifest === undefined ? '' : `, manifest: ${JSON.stringify(plugin.manifest)}`
    const packageField = plugin.package === undefined ? '' : `, package: ${JSON.stringify(plugin.package)}`
    const developmentField = plugin.development === undefined ? '' : `, development: ${JSON.stringify(plugin.development)}`
    return `{ id: ${JSON.stringify(plugin.id)}, source: ${JSON.stringify(plugin.source ?? pathToFileURL(plugin.entry).href)}, enabled: ${plugin.enabled}, config: ${JSON.stringify(plugin.config)}, revision: ${plugin.revision ?? 0}${readmeField}${readmesField}${manifestField}${packageField}${developmentField}${artifactGenerationField}${moduleField} }`
  }).join(',')}]`
  const providers = [
    ...config.providers.filter(provider => provider.enabled).map(provider => ({ id: provider.id, displayName: provider.displayName })),
    ...(config.codex.agentLoopBackend === 'local-cli' ? [{ id: 'codex-local', displayName: 'Local Codex' }] : []),
  ]
  const permission = options.permission ?? { profileId: options.profileId ?? 'development', policies: [] }
  const metadata = `{ version: ${JSON.stringify(version)}, workspaceCwd: ${JSON.stringify(config.rootDir)}, providers: ${JSON.stringify(providers)}, profileId: ${JSON.stringify(permission.profileId)}, permissionPolicies: ${JSON.stringify(permission.policies)}${options.playground === true ? ', hostKind: "playground"' : ''}${options.appId === undefined ? '' : `, appId: ${JSON.stringify(options.appId)}`}${options.iconThemePreference === undefined ? '' : `, iconThemePreference: ${JSON.stringify(options.iconThemePreference)}`}${options.iconThemePreferenceBridgeToken === undefined ? '' : `, iconThemePreferenceBridgeToken: ${JSON.stringify(options.iconThemePreferenceBridgeToken)}`}${options.generation === undefined ? '' : `, generation: ${JSON.stringify(options.generation)}`}${options.providerBridgeToken === undefined ? '' : `, providerBridgeToken: ${JSON.stringify(options.providerBridgeToken)}`}${options.agentHistoryBridgeToken === undefined ? '' : `, agentHistoryBridgeToken: ${JSON.stringify(options.agentHistoryBridgeToken)}`}${options.configBridgeToken === undefined ? '' : `, configBridgeToken: ${JSON.stringify(options.configBridgeToken)}`}${options.serviceConfigBridgeToken === undefined ? '' : `, serviceConfigBridgeToken: ${JSON.stringify(options.serviceConfigBridgeToken)}`}${options.channelCredentialBridgeToken === undefined ? '' : `, channelCredentialBridgeToken: ${JSON.stringify(options.channelCredentialBridgeToken)}`}${options.channelActionsBridgeToken === undefined ? '' : `, channelActionsBridgeToken: ${JSON.stringify(options.channelActionsBridgeToken)}`}${options.pluginLifecycleBridgeToken === undefined ? '' : `, pluginLifecycleBridgeToken: ${JSON.stringify(options.pluginLifecycleBridgeToken)}`}${options.pluginActivation === undefined ? '' : `, pluginActivation: ${JSON.stringify(options.pluginActivation)}`}${options.initialRegistryEpoch === undefined ? '' : `, initialRegistryEpoch: ${JSON.stringify(options.initialRegistryEpoch)}`}${options.channelManager === undefined ? '' : `, channelManager: ${JSON.stringify(options.channelManager)}`}${permission.bridgeToken === undefined ? '' : `, permissionBridgeToken: ${JSON.stringify(permission.bridgeToken)}`} }`
  const boot = `installCordisX(${composition}, ${metadata})`
  const source = sourceOptions.awaitBoot === true
    ? `${imports.join('\n')}\nexport const runtime = await ${boot}\n`
    : `${imports.join('\n')}\nvoid ${boot}.catch(error => console.error('[cordisx] boot failed', error))\n`
  return {
    source,
    watchFiles: [...new Set([
      ...enabled.map(plugin => plugin.entry),
      ...readmes.flatMap(readme => readme.files),
    ])],
  }
}

/** Bundle the renderer host and every enabled plugin into one Cordis generation. */
export async function buildRendererBundle(config: CordisXConfig, options: BuildRendererBundleOptions = {}): Promise<string> {
  const { source } = await buildRendererCompositionSource(config, options)

  const result = await build({
    stdin: { contents: source, resolveDir: config.rootDir, sourcefile: 'cordisx-composition.ts' },
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
  if (output === undefined) throw new Error('esbuild produced no renderer bundle')
  return output.text
}
