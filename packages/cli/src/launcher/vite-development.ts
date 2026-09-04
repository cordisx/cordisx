import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer, normalizePath, type ModuleNode, type Plugin, type ViteDevServer } from 'vite'
import { buildRendererCompositionSource, type BuildRendererBundleOptions } from './bundle.js'
import type { CordisXConfig, CordisXConfigPlugin } from './config.js'
import { findFreeLoopbackPort } from './process.js'
import { buildLocalDevelopmentPlugin, localDevelopmentPackageInfo } from './development.js'
import type { CordisXPluginManifestV7, CordisXPluginManifestV8 } from '../permission-contracts.js'
import { EntityDirectoryAuthority, type EntityTemplatePayload } from './entity-directory.js'
import { CONTRACTS_MODULE_PATH, cordisXSharedModuleSource } from './react-virtual-modules.js'
import { entityInstallationId, entityPluginGeneration, issueOwnerDocumentPrincipalToken } from './owner-document-rpc.js'

const ENTRY = 'virtual:cordisx-native-entry'
const BOOT = 'virtual:cordisx-native-boot'
const PREAMBLE = 'virtual:cordisx-native-preamble'
const REACT_PREPARE = 'virtual:cordisx-native-react-prepare'
const PLUGIN_PREFIX = 'virtual:cordisx-native-plugin/'
const SHARED_PREFIX = 'virtual:cordisx-native-shared/'
const SHARED_MODULES = new Set([
  'cordisx/react',
  'cordisx/react/jsx-runtime',
  'cordisx/react/jsx-dev-runtime',
  'cordisx/ui',
])
const sourceMode = import.meta.url.endsWith('.ts')
const extension = sourceMode ? 'ts' : 'js'
const rendererPath = fileURLToPath(new URL(`../renderer/runtime.${extension}`, import.meta.url))
const clientPath = fileURLToPath(new URL(`../renderer/vite-development-client.${extension}`, import.meta.url))
const reactRuntimePath = fileURLToPath(new URL(`../renderer/react-runtime.${extension}`, import.meta.url))
const require = createRequire(import.meta.url)
const reactPackageRoot = path.dirname(require.resolve('react/package.json'))
const reactDomPackageRoot = path.dirname(require.resolve('react-dom/package.json'))
const packageVersion = (specifier: string): string => (require(specifier) as { readonly version: string }).version
const viteVersion = packageVersion('vite/package.json')
const reactPluginVersion = packageVersion(path.resolve(path.dirname(require.resolve('@vitejs/plugin-react')), '..', 'package.json'))
const reactVersion = packageVersion('react/package.json')
const reactDomVersion = packageVersion('react-dom/package.json')
const virtualUrl = (id: string): string => `/@id/__x00__${id}`
const README_FILE = /^README(?:\.[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?\.(?:md|markdown)$/iu
const VITE_CLIENT_DISPOSER_SOURCE = `
const __cordisxDisposeViteHmr = async () => {
  for (const id of new Set([...sheetsMap.keys(), ...linkSheetsMap.keys()])) removeStyle(id);
  willUnload = true;
  await transport.connect().catch(() => undefined);
  await transport.disconnect();
  if (globalThis.__cordisxViteHmrDispose === __cordisxDisposeViteHmr) delete globalThis.__cordisxViteHmrDispose;
};
globalThis.__cordisxViteHmrDispose = __cordisxDisposeViteHmr;
`

interface DevelopmentGeneration {
  readonly root: string
  readonly realRoot: string
  readonly realEntry: string
  version: string
  readonly source: string
  revision: number
  digest: `sha256:${string}`
  moduleGeneration: string
  lastSuccessfulAt: string
  readonly packageFiles: readonly string[]
  readonly entityTemplates: readonly EntityTemplatePayload[]
  readonly manifest?: CordisXPluginManifestV7 | CordisXPluginManifestV8
  /** Executable only by the Host-owned isolated Worker boundary. */
  readonly isolatedArtifactSource?: string
  /** Complete esbuild input graph for isolated-worker HMR ownership. */
  readonly watchFiles: readonly string[]
}

export interface NativeVitePluginGeneration {
  readonly pluginId: string
  readonly version: string
  readonly digest: `sha256:${string}`
  readonly moduleGeneration: string
  readonly entityTemplates: readonly EntityTemplatePayload[]
}

export interface NativeVitePluginGenerationTransaction {
  commit(): Promise<void>
  rollback(): Promise<void>
}

export type NativeVitePluginGenerationHandler = (
  generation: NativeVitePluginGeneration,
) => Promise<NativeVitePluginGenerationTransaction>

/** Keep Host entity declarations aligned with generations acknowledged by the renderer. */
export function createNativeViteEntityGenerationHandler(
  authority: EntityDirectoryAuthority,
  profileId: string,
): NativeVitePluginGenerationHandler {
  const committed = new Map<string, readonly EntityTemplatePayload['declaration'][]>()
  const staging = new Set<string>()
  return async generation => {
    if (staging.has(generation.pluginId)) throw new Error(`plugin ${generation.pluginId} already has a staged entity generation`)
    staging.add(generation.pluginId)
    const binding = {
      profileId,
      installationId: entityInstallationId(profileId, generation.pluginId),
      pluginId: generation.pluginId,
      pluginGeneration: entityPluginGeneration(generation.moduleGeneration),
    }
    const declarations = generation.entityTemplates.map(template => template.declaration)
    const previous = committed.get(generation.pluginId)
    authority.register(binding, declarations)
    try {
      const materialized = await authority.materialize(
        binding, generation.version, generation.digest, generation.entityTemplates,
      )
      const rejected = materialized.find(result => result.status === 'rejected')
      if (rejected !== undefined) throw new Error(`entity template ${rejected.agentId} was rejected: ${rejected.code}`)
    } catch (error) {
      authority.register(binding, previous ?? [])
      staging.delete(generation.pluginId)
      throw error
    }
    let settled = false
    return {
      async commit() {
        if (settled) return
        settled = true
        committed.set(generation.pluginId, declarations)
        staging.delete(generation.pluginId)
      },
      async rollback() {
        if (settled) return
        settled = true
        authority.register(binding, previous ?? [])
        staging.delete(generation.pluginId)
      },
    }
  }
}

interface ReloadPluginRequest {
  readonly pluginId?: unknown
  readonly requestId?: unknown
}

interface GenerationTransactionRequest extends ReloadPluginRequest {
  readonly action?: unknown
  readonly moduleGeneration?: unknown
  readonly transactionId?: unknown
}

export interface NativeViteServer {
  readonly url: string
  readonly cacheDir: string
  buildBootstrap(config: CordisXConfig, options: BuildRendererBundleOptions): Promise<string>
  /** Install the Host-owned package-generation sink and synchronize current templates. */
  synchronizePluginGenerations(handler: NativeVitePluginGenerationHandler): Promise<void>
  close(): Promise<void>
}

export interface NativeViteServerOptions {
  /** User-private cache root supplied by the launcher. */
  readonly cacheRoot?: string
  /** Crawl the full Host and plugin entries before opening the native window. */
  readonly prebundleHostDependencies?: boolean
}

async function ensurePrivateCacheDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`CordisX Vite cache path must be a real directory: ${directory}`)
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`CordisX Vite cache path is owned by another user: ${directory}`)
  }
  await chmod(directory, 0o700)
}

function inside(file: string, directory: string): boolean {
  const relative = path.relative(directory, file)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

/** Vite owns source transformation, HTTP module delivery, and the HMR WebSocket. */
export async function startNativeViteServer(
  initialConfig: CordisXConfig,
  serverOptions: NativeViteServerOptions = {},
): Promise<NativeViteServer> {
  if (initialConfig.plugins.some(plugin => plugin.enabled
    && (plugin.manifest?.schemaVersion === 5 || plugin.manifest?.schemaVersion === 6)
    && plugin.manifest.capabilities.some(capability => capability.name === 'ui.host-dom.read' || capability.name === 'ui.host-dom.modify'))) {
    throw new Error('Native Vite development supports structured renderer plugins; isolated Host DOM plugins require packaged launch')
  }
  const cliPackage = await localDevelopmentPackageInfo(fileURLToPath(import.meta.url))
  const cliRoot = cliPackage.root
  const workspaceRoot = await realpath(initialConfig.projectRoot ?? initialConfig.rootDir)
    .catch(() => path.resolve(initialConfig.projectRoot ?? initialConfig.rootDir))
  const generatedRoot = path.join(cliRoot, 'dist') + path.sep
  const port = await findFreeLoopbackPort()
  const cacheKey = createHash('sha256')
    .update('cordisx.native-vite-cache.v2\0')
    .update(cliRoot)
    .update('\0')
    .update(workspaceRoot)
    .update('\0')
    .update([cliPackage.version, viteVersion, reactPluginVersion, reactVersion, reactDomVersion].join('\0'))
    .digest('hex')
    .slice(0, 32)
  const cacheRoot = path.resolve(serverOptions.cacheRoot ?? path.join(initialConfig.rootDir, '.cordisx', 'cache', 'native-vite'))
  await ensurePrivateCacheDirectory(cacheRoot)
  const cacheDir = path.join(cacheRoot, cacheKey)
  await ensurePrivateCacheDirectory(cacheDir)
  const origin = `http://127.0.0.1:${port}`
  const base = `/cordisx-dev-${randomBytes(24).toString('hex')}/`
  const sessionGeneration = randomBytes(24).toString('base64url')
  const url = (id: string): string => origin + base.slice(0, -1) + virtualUrl(id)
  let config = initialConfig
  let options: BuildRendererBundleOptions | undefined
  let server: ViteDevServer
  const generations = new Map<string, DevelopmentGeneration>()
  const pendingGenerations = new Map<string, Map<string, DevelopmentGeneration>>()
  let generationHandler: NativeVitePluginGenerationHandler | undefined
  const generationTransactions = new Map<string, {
    readonly handle: NativeVitePluginGenerationTransaction
    readonly timeout: ReturnType<typeof setTimeout>
    readonly pluginId: string
    readonly moduleGeneration: string
  }>()
  const sourceMaps = new Map<string, string>()
  const fileHashes = new Map<string, string>()

  const waitForDependencyOptimization = async (): Promise<void> => {
    const client = server.environments.client
    const optimizer = client?.depsOptimizer
    await optimizer?.scanProcessing
    await client?.waitForRequestsIdle()
    await Promise.allSettled(Object.values(optimizer?.metadata.discovered ?? {})
      .flatMap(dependency => dependency.processing === undefined ? [] : [dependency.processing]))
  }

  const hashSource = (source: string | Buffer): string => createHash('sha256').update(source).digest('hex')
  const rememberFile = async (file: string): Promise<void> => {
    const realFile = await realpath(file).catch(() => path.resolve(file))
    const source = await readFile(realFile).catch(() => undefined)
    if (source !== undefined) fileHashes.set(realFile, hashSource(source))
  }
  const rememberPluginMetadata = async (realEntry: string, realRoot: string, packageFiles: readonly string[]): Promise<void> => {
    await rememberFile(path.join(realRoot, 'package.json'))
    for (const file of packageFiles) await rememberFile(file)
    let directory = path.dirname(realEntry)
    while (inside(directory, realRoot)) {
      const names = await readdir(directory).catch(() => [])
      await Promise.all(names.filter(name => README_FILE.test(name)).map(name => rememberFile(path.join(directory, name))))
      if (directory === realRoot) return
      const parent = path.dirname(directory)
      if (parent === directory) return
      directory = parent
    }
  }

  const generationSnapshot = (pluginId: string, generation: DevelopmentGeneration): NativeVitePluginGeneration => ({
    pluginId,
    version: generation.version,
    digest: generation.digest,
    moduleGeneration: generation.moduleGeneration,
    entityTemplates: generation.entityTemplates,
  })

  const generationValues = (pluginId: string, revision: number): Pick<DevelopmentGeneration, 'digest' | 'moduleGeneration'> => {
    const value = createHash('sha256')
      .update('cordisx.vite-plugin-generation.v1\0')
      .update(sessionGeneration)
      .update('\0')
      .update(pluginId)
      .update('\0')
      .update(String(revision))
      .digest('hex')
    return { digest: `sha256:${value}`, moduleGeneration: `vite-${value.slice(0, 40)}` }
  }
  const ensureGeneration = async (plugin: CordisXConfigPlugin): Promise<DevelopmentGeneration> => {
    const current = generations.get(plugin.id)
    if (current !== undefined) return current
    const info = await localDevelopmentPackageInfo(plugin.entry)
    const isolatedBuild = info.manifest === undefined
      ? undefined
      : await buildLocalDevelopmentPlugin(plugin.entry, { sourcemap: false })
    if (isolatedBuild !== undefined && isolatedBuild.id !== plugin.id) {
      throw new Error(`isolated development plugin id ${isolatedBuild.id} does not match config id ${plugin.id}`)
    }
    const realEntry = await realpath(plugin.entry)
    const realRoot = await realpath(info.root).catch(() => path.resolve(info.root))
    const packageFiles = [...new Set([path.join(realRoot, 'cordisx-package.json'), ...info.packageFiles])]
    await rememberPluginMetadata(realEntry, realRoot, packageFiles)
    const sourceKey = createHash('sha256').update(path.resolve(plugin.entry)).digest('hex').slice(0, 24)
    const created: DevelopmentGeneration = {
      root: info.root,
      realRoot,
      realEntry,
      version: info.version,
      source: `file:///cordisx-local-dev/${sourceKey}/${plugin.id}.js`,
      revision: 0,
      ...generationValues(plugin.id, 0),
      lastSuccessfulAt: new Date().toISOString(),
      packageFiles,
      entityTemplates: info.entityTemplates,
      ...(info.manifest === undefined ? {} : { manifest: info.manifest }),
      ...(isolatedBuild === undefined ? {} : { isolatedArtifactSource: isolatedBuild.runtimeArtifactSource }),
      watchFiles: isolatedBuild?.watchFiles ?? [realEntry, ...packageFiles],
    }
    generations.set(plugin.id, created)
    return created
  }
  const bumpGeneration = async (plugin: CordisXConfigPlugin): Promise<DevelopmentGeneration> => {
    const previous = await ensureGeneration(plugin)
    const info = await localDevelopmentPackageInfo(plugin.entry)
    const isolatedBuild = info.manifest === undefined
      ? undefined
      : await buildLocalDevelopmentPlugin(plugin.entry, { sourcemap: false })
    if (isolatedBuild !== undefined && isolatedBuild.id !== plugin.id) {
      throw new Error(`isolated development plugin id ${isolatedBuild.id} does not match config id ${plugin.id}`)
    }
    const packageFiles = [...new Set([path.join(previous.realRoot, 'cordisx-package.json'), ...info.packageFiles])]
    await rememberPluginMetadata(previous.realEntry, previous.realRoot, packageFiles)
    const watchFiles = isolatedBuild?.watchFiles ?? [previous.realEntry, ...packageFiles]
    server?.watcher.add(watchFiles)
    const next: DevelopmentGeneration = {
      ...previous,
      revision: previous.revision + 1,
      version: info.version,
      ...generationValues(plugin.id, previous.revision + 1),
      lastSuccessfulAt: new Date().toISOString(),
      packageFiles,
      entityTemplates: info.entityTemplates,
      ...(info.manifest === undefined ? {} : { manifest: info.manifest }),
      ...(isolatedBuild === undefined ? {} : { isolatedArtifactSource: isolatedBuild.runtimeArtifactSource }),
      watchFiles,
    }
    generations.set(plugin.id, next)
    const pending = pendingGenerations.get(plugin.id) ?? new Map<string, DevelopmentGeneration>()
    pending.set(next.moduleGeneration, next)
    pendingGenerations.set(plugin.id, pending)
    return next
  }
  const packageConfig = async (plugin: CordisXConfigPlugin): Promise<CordisXConfigPlugin> => {
    const generation = await ensureGeneration(plugin)
    return {
      ...plugin,
      source: generation.source,
      package: {
        version: generation.version,
        digest: generation.digest,
        moduleGeneration: generation.moduleGeneration,
        dependencies: [],
      },
      development: {
        origin: 'local-dev',
        pluginId: plugin.id,
        sourcePath: plugin.entry,
        state: 'ready',
        lastSuccessfulAt: generation.lastSuccessfulAt,
      },
      ...(generation.manifest === undefined ? {} : { manifest: generation.manifest }),
    }
  }
  const compiledConfig = async (): Promise<CordisXConfig> => ({
    ...config,
    plugins: await Promise.all(config.plugins.map(async plugin => plugin.enabled ? await packageConfig(plugin) : plugin)),
  })
  const ownerBindings = (plugin: CordisXConfigPlugin): readonly Record<string, unknown>[] => {
    if (options?.ownerDocumentAuthority === undefined || plugin.package === undefined || plugin.source === undefined) return []
    const authority = options.ownerDocumentAuthority
    return [{
      source: plugin.source,
      pluginId: plugin.id,
      moduleGeneration: plugin.package.moduleGeneration,
      installationId: entityInstallationId(authority.profileId, plugin.id),
      pluginGeneration: entityPluginGeneration(plugin.package.moduleGeneration),
      token: issueOwnerDocumentPrincipalToken(authority.secret, {
        profileId: authority.profileId,
        generation: authority.generation,
        moduleGeneration: plugin.package.moduleGeneration,
        identity: { source: plugin.source, pluginId: plugin.id },
      }),
    }]
  }
  const pluginModule = async (plugin: CordisXConfigPlugin): Promise<string> => {
    const compiled = await packageConfig(plugin)
    const { entry: _entry, moduleFactorySource: _factory, ...descriptor } = compiled
    const generation = await ensureGeneration(plugin)
    if (generation.isolatedArtifactSource !== undefined) {
      const artifact = {
        plugin: { ...descriptor, isolatedArtifactSource: generation.isolatedArtifactSource },
        ownerDocumentBindings: ownerBindings(compiled),
      }
      return `export async function load() { return ${JSON.stringify(artifact)}; }\n`
    }
    const entryUrl = `/@fs/${normalizePath(generation.realEntry)}?cordisx-plugin-generation=${encodeURIComponent(compiled.package!.moduleGeneration)}`
    return `const plugin = ${JSON.stringify(descriptor)};\nexport async function load() { const pluginModule = await import(${JSON.stringify(entryUrl)}); return { plugin: { ...plugin, module: pluginModule }, ownerDocumentBindings: ${JSON.stringify(ownerBindings(compiled))} }; }\n`
  }
  const entryModule = async (): Promise<string> => {
    if (options === undefined) throw new Error('Vite bootstrap has not been configured')
    const compiled = await compiledConfig()
    const composition = await buildRendererCompositionSource(compiled, options, { omitPluginModules: true })
    const plugins = compiled.plugins.filter(plugin => plugin.enabled)
    const hostImport = `/@fs/${normalizePath(rendererPath)}`
    const helperImport = `/@fs/${normalizePath(clientPath)}`
    const pluginImports = plugins.map(plugin => PLUGIN_PREFIX + plugin.id)
    const pluginUrls = plugins.map(plugin => url(PLUGIN_PREFIX + plugin.id))
    return `
import { installCordisX, prepareCordisXViteReactRuntime } from ${JSON.stringify(hostImport)};
import { NativeViteDevelopmentClient } from ${JSON.stringify(helperImport)};
${pluginImports.map((id, index) => `import * as p${index} from ${JSON.stringify(id)};`).join('\n')}
const previous = globalThis.__cordisxViteClient;
if (previous) await previous.dispose(true);
const disposeSharedReactRuntime = prepareCordisXViteReactRuntime(document);
const descriptors = ${composition.pluginsSource};
const pluginUrls = ${JSON.stringify(pluginUrls)};
const withDescriptor = artifact => ({ ...artifact, plugin: { ...descriptors.find(item => item.id === artifact.plugin.id), ...artifact.plugin } });
const replacePlugin = (pluginId, timestamp) => {
  const index = descriptors.findIndex(plugin => plugin.id === pluginId);
  const pluginUrl = pluginUrls[index];
  if (!pluginUrl) return Promise.reject(new Error('Unknown Vite development plugin: ' + pluginId));
  return import(/* @vite-ignore */ pluginUrl + '?t=' + timestamp)
    .then(module => module.load())
    .then(withDescriptor)
    .then(artifact => client.update(artifact));
};
let client;
const reloadWaiters = new Map();
const generationWaiters = new Map();
const developmentReloadPlugin = pluginId => new Promise((resolve, reject) => {
  if (!import.meta.hot) { reject(new Error('Vite HMR is unavailable')); return; }
  const requestId = crypto.randomUUID();
  const timeout = setTimeout(() => { reloadWaiters.delete(requestId); reject(new Error('Vite plugin reload timed out')); }, 10000);
  reloadWaiters.set(requestId, { pluginId, resolve, reject, timeout });
  import.meta.hot.send('cordisx:reload-plugin', { pluginId, requestId });
});
const requestPluginGeneration = (action, pluginId, moduleGeneration, transactionId) => new Promise((resolve, reject) => {
  if (!import.meta.hot) { reject(new Error('Vite HMR is unavailable')); return; }
  const requestId = crypto.randomUUID();
  const timeout = setTimeout(() => { generationWaiters.delete(requestId); reject(new Error('Vite plugin generation transaction timed out')); }, 10000);
  generationWaiters.set(requestId, { resolve, reject, timeout });
  import.meta.hot.send('cordisx:plugin-generation-transaction', { action, pluginId, moduleGeneration, transactionId, requestId });
});
const stagePluginGeneration = async (pluginId, moduleGeneration) => {
  const transactionId = crypto.randomUUID();
  await requestPluginGeneration('stage', pluginId, moduleGeneration, transactionId);
  return {
    commit: () => requestPluginGeneration('commit', pluginId, moduleGeneration, transactionId),
    rollback: () => requestPluginGeneration('rollback', pluginId, moduleGeneration, transactionId),
  };
};
try {
  const modules = await Promise.all([${plugins.map((_, index) => `p${index}.load()`).join(',')}]);
  const initial = descriptors.map(plugin => {
    const artifact = modules.find(item => item.plugin.id === plugin.id);
    return artifact ? withDescriptor(artifact) : { plugin, ownerDocumentBindings: [] };
  });
  client = new NativeViteDevelopmentClient({ ...${composition.metadataSource}, developmentReloadPlugin }, initial, disposeSharedReactRuntime, stagePluginGeneration);
  globalThis.__cordisxViteClient = client;
} catch (error) {
  disposeSharedReactRuntime();
  throw error;
}
export const ready = client.restart(installCordisX);
if (import.meta.hot) {
  ${pluginImports.length === 0 ? '' : `import.meta.hot.accept(${JSON.stringify(pluginImports)}, modules => { for (const module of modules) if (module) void module.load().then(withDescriptor).then(artifact => client.update(artifact)).catch(() => {}); });`}
  import.meta.hot.on('cordisx:reload-plugin-result', data => {
    const waiter = reloadWaiters.get(data.requestId);
    if (!waiter) return;
    reloadWaiters.delete(data.requestId);
    clearTimeout(waiter.timeout);
    if (data.error) { waiter.reject(new Error(data.error)); return; }
    replacePlugin(waiter.pluginId, data.timestamp).then(waiter.resolve, waiter.reject);
  });
  import.meta.hot.on('cordisx:plugin-generation-transaction-result', data => {
    const waiter = generationWaiters.get(data.requestId);
    if (!waiter) return;
    generationWaiters.delete(data.requestId);
    clearTimeout(waiter.timeout);
    if (data.error) waiter.reject(new Error(data.error)); else waiter.resolve();
  });
  import.meta.hot.on('cordisx:replace-plugin', data => {
    void replacePlugin(data.pluginId, data.timestamp).catch(error => console.error('[cordisx] Vite plugin replacement failed', error));
  });
}
`
  }
  const pluginIdFromModule = (module: ModuleNode): string | undefined => {
    const id = module.id ?? ''
    const index = id.indexOf(PLUGIN_PREFIX)
    return index < 0 ? undefined : id.slice(index + PLUGIN_PREFIX.length).split('?')[0]
  }
  const importingPluginIds = (modules: readonly ModuleNode[]): Set<string> => {
    const ids = new Set<string>()
    const seen = new Set<ModuleNode>()
    const visit = (module: ModuleNode): void => {
      if (seen.has(module)) return
      seen.add(module)
      const id = pluginIdFromModule(module)
      if (id !== undefined) ids.add(id)
      for (const importer of module.importers) visit(importer)
    }
    for (const module of modules) visit(module)
    return ids
  }
  const importsModule = (module: ModuleNode, target: ModuleNode, seen = new Set<ModuleNode>()): boolean => {
    if (module === target || (module.file !== null && target.file !== null && module.file === target.file)) return true
    if (seen.has(module)) return false
    seen.add(module)
    for (const dependency of module.importedModules) {
      if (importsModule(dependency, target, seen)) return true
    }
    return false
  }
  const owningPluginIds = async (module: ModuleNode): Promise<Set<string>> => {
    const owners = importingPluginIds([module])
    for (const plugin of config.plugins) {
      if (!plugin.enabled || owners.has(plugin.id)) continue
      const generation = await ensureGeneration(plugin)
      const entries = server.moduleGraph.getModulesByFile(generation.realEntry) ?? new Set<ModuleNode>()
      if ([...entries].some(entry => importsModule(entry, module))) owners.add(plugin.id)
    }
    return owners
  }
  const hasReadme = async (directory: string): Promise<boolean> => await readdir(directory)
    .then(names => names.some(name => README_FILE.test(name)), () => false)
  const isPluginReadmeChange = async (file: string, generation: DevelopmentGeneration): Promise<boolean> => {
    if (!README_FILE.test(path.basename(file))) return false
    const changedDirectory = path.dirname(file)
    const entryDirectory = path.dirname(generation.realEntry)
    if (!inside(entryDirectory, changedDirectory) || !inside(changedDirectory, generation.realRoot)) return false
    let directory = entryDirectory
    while (directory !== changedDirectory) {
      if (await hasReadme(directory)) return false
      const parent = path.dirname(directory)
      if (parent === directory) return false
      directory = parent
    }
    return true
  }
  const invalidatePluginModule = (pluginId: string, timestamp: number): ModuleNode | undefined => {
    const module = server.moduleGraph.getModuleById('\0' + PLUGIN_PREFIX + pluginId)
    if (module !== undefined) server.moduleGraph.invalidateModule(module, new Set(), timestamp, true)
    return module
  }
  const invalidatePlugin = async (pluginId: string, timestamp: number): Promise<void> => {
    const plugin = config.plugins.find(item => item.id === pluginId && item.enabled)
    if (plugin === undefined) throw new Error(`Unknown Vite development plugin: ${pluginId}`)
    await bumpGeneration(plugin)
    invalidatePluginModule(plugin.id, timestamp)
  }
  const validateModuleGraph = async (module: ModuleNode, seen = new Set<ModuleNode>()): Promise<void> => {
    if (seen.has(module)) return
    seen.add(module)
    await server.transformRequest(module.url)
    for (const dependency of module.importedModules) await validateModuleGraph(dependency, seen)
  }
  const validatePlugin = async (plugin: CordisXConfigPlugin): Promise<void> => {
    try {
      const request = '\0' + PLUGIN_PREFIX + plugin.id
      await server.transformRequest(request)
      const module = server.moduleGraph.getModuleById(request)
      if (module === undefined) throw new Error(`Vite did not create a module graph for plugin ${plugin.id}`)
      await validateModuleGraph(module)
    } catch (error) {
      throw new Error(`Build failed for plugin ${plugin.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  const integration: Plugin = {
    name: 'cordisx-native-development',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === ENTRY || id === BOOT || id === PREAMBLE || id === REACT_PREPARE || id.startsWith(PLUGIN_PREFIX) || id.startsWith(SHARED_PREFIX)) return '\0' + id
      if (id === 'cordisx/contracts') return CONTRACTS_MODULE_PATH
      if (SHARED_MODULES.has(id)) return '\0' + SHARED_PREFIX + id
      if (/^react(?:-dom)?(?:\/.*)?$/.test(id) && importer !== undefined && !normalizePath(importer).includes('/node_modules/')) {
        const source = normalizePath(importer.split('?')[0]!)
        const directPluginImport = config.plugins.some(plugin => inside(source, path.dirname(normalizePath(plugin.entry))))
        if (directPluginImport) throw new Error(`plugin source must import ${id.startsWith('react-dom') ? 'renderer primitives' : 'React'} from cordisx/react and cordisx/ui`)
      }
      return undefined
    },
    async load(id) {
      if (id === '\0' + BOOT) return `
let queue = Promise.resolve();
export function start() {
  const task = queue.catch(() => {}).then(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await import(/* @vite-ignore */ ${JSON.stringify(url(REACT_PREPARE))} + '?t=' + Date.now());
        const entry = await import(/* @vite-ignore */ ${JSON.stringify(url(ENTRY))} + '?t=' + Date.now());
        return await entry.ready;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  });
  queue = task;
  return task;
}
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.on('cordisx:restart-host', () => { void start().catch(error => console.error('[cordisx] Vite Host reload failed', error)); });
}
`
      if (id === '\0' + PREAMBLE) return `import RefreshRuntime from '/@react-refresh';\nRefreshRuntime.injectIntoGlobalHook(window);\nwindow.$RefreshReg$ = () => {};\nwindow.$RefreshSig$ = () => type => type;\nwindow.__vite_plugin_react_preamble_installed__ = true;\n`
      if (id === '\0' + REACT_PREPARE) return `import { installSharedReactRuntime } from ${JSON.stringify(`/@fs/${normalizePath(reactRuntimePath)}`)};\nif (!globalThis.__cordisxSharedReactRuntime) installSharedReactRuntime(document);\n`
      if (id === '\0' + ENTRY) return await entryModule()
      if (id.startsWith('\0' + SHARED_PREFIX)) return cordisXSharedModuleSource(id.slice(SHARED_PREFIX.length + 1))
      if (id.startsWith('\0' + PLUGIN_PREFIX)) {
        const plugin = config.plugins.find(item => item.id === id.slice(PLUGIN_PREFIX.length + 1))
        if (plugin === undefined || !plugin.enabled) throw new Error('Unknown Vite development plugin')
        return await pluginModule(plugin)
      }
      return undefined
    },
    async transform(source, id) {
      if (!/\.[cm]?[jt]sx?(?:\?|$)/.test(id)) return undefined
      const sourcePath = id.split('?')[0]!
      if (path.isAbsolute(sourcePath)) {
        const realFile = await realpath(sourcePath).catch(() => path.resolve(sourcePath))
        fileHashes.set(realFile, hashSource(source))
      }
      const code = source.replace(/(from\s+['"][^'"]+\.css)(['"])/g, '$1?inline$2')
        .replace(/(from\s+['"][^'"]+\.svg)(['"])/g, '$1?raw$2')
      return code === source ? undefined : { code, map: null }
    },
    async handleHotUpdate(context) {
      if (sourceMode && context.file.startsWith(generatedRoot)) return []
      const owners = importingPluginIds(context.modules)
      for (const module of context.modules) {
        for (const pluginId of await owningPluginIds(module)) owners.add(pluginId)
      }
      const realFile = await realpath(context.file).catch(() => path.resolve(context.file))
      const currentSource = await Promise.resolve(context.read()).catch(() => undefined)
      const currentHash = currentSource === undefined ? '<deleted>' : hashSource(currentSource)
      if (fileHashes.get(realFile) === currentHash) return []
      fileHashes.set(realFile, currentHash)
      const refreshBoundaryHandlesUpdate = context.modules.some(module => module.isSelfAccepting)
      const replacements = new Set<string>()
      const enabled = config.plugins.filter(plugin => plugin.enabled)
      const entries = await Promise.all(enabled.map(async plugin => ({ plugin, generation: await ensureGeneration(plugin) })))
      const directEntryOwners = new Set(entries
        .filter(({ generation }) => realFile === generation.realEntry)
        .map(({ plugin }) => plugin.id))
      for (const { plugin, generation } of entries) {
        const readmeChange = await isPluginReadmeChange(realFile, generation)
        const metadataChange = realFile === path.join(generation.realRoot, 'package.json')
          || generation.packageFiles.includes(realFile) || readmeChange
        if (metadataChange) {
          await invalidatePlugin(plugin.id, context.timestamp)
          replacements.add(plugin.id)
        } else if ((generation.isolatedArtifactSource !== undefined && generation.watchFiles.includes(realFile))
          || directEntryOwners.has(plugin.id)
          || (owners.has(plugin.id) && (directEntryOwners.size > 0 || !refreshBoundaryHandlesUpdate))) {
          await bumpGeneration(plugin)
          invalidatePluginModule(plugin.id, context.timestamp)
          replacements.add(plugin.id)
        }
      }
      if (replacements.size === 0) return undefined
      const hot = context.server.environments.client!.hot
      for (const pluginId of replacements) {
        hot.send({
          type: 'custom', event: 'cordisx:replace-plugin',
          data: { pluginId, timestamp: context.timestamp, sourcePath: realFile },
        })
      }
      return []
    },
    configureServer(vite) {
      const hot = vite.environments.client!.hot
      hot.on?.('vite:invalidate', data => {
        void (async () => {
          const requestedPath = data.path.split('?')[0]
          const invalidated = await vite.moduleGraph.getModuleByUrl(data.path)
            ?? [...vite.moduleGraph.urlToModuleMap.entries()]
              .find(([moduleUrl]) => moduleUrl.split('?')[0] === requestedPath)?.[1]
          if (invalidated === undefined) return
          const timestamp = Date.now()
          for (const pluginId of await owningPluginIds(invalidated)) {
            await invalidatePlugin(pluginId, timestamp)
            hot.send({ type: 'custom', event: 'cordisx:replace-plugin', data: { pluginId, timestamp } })
          }
        })().catch(error => vite.config.logger.error(
          `[cordisx] failed to replace invalidated plugin: ${error instanceof Error ? error.message : String(error)}`,
        ))
      })
      hot.on?.('cordisx:reload-plugin', (data: ReloadPluginRequest, client) => {
        const requestId = typeof data.requestId === 'string' ? data.requestId : ''
        const pluginId = typeof data.pluginId === 'string' ? data.pluginId : ''
        const timestamp = Date.now()
        void invalidatePlugin(pluginId, timestamp).then(() => {
          client.send({ type: 'custom', event: 'cordisx:reload-plugin-result', data: { requestId, pluginId, timestamp } })
        }, error => {
          client.send({ type: 'custom', event: 'cordisx:reload-plugin-result', data: { requestId, pluginId, timestamp, error: error instanceof Error ? error.message : String(error) } })
        })
      })
      hot.on?.('cordisx:plugin-generation-transaction', (data: GenerationTransactionRequest, client) => {
        const requestId = typeof data.requestId === 'string' ? data.requestId : ''
        const pluginId = typeof data.pluginId === 'string' ? data.pluginId : ''
        const moduleGeneration = typeof data.moduleGeneration === 'string' ? data.moduleGeneration : ''
        const transactionId = typeof data.transactionId === 'string' ? data.transactionId : ''
        const action = data.action
        const task = (async () => {
          if (action === 'stage') {
            const generation = pendingGenerations.get(pluginId)?.get(moduleGeneration)
            if (generation === undefined) throw new Error('Unknown or stale Vite plugin generation')
            if (generationTransactions.has(transactionId)) throw new Error('Vite plugin generation transaction already exists')
            const transaction = generationHandler === undefined
              ? { commit: async () => undefined, rollback: async () => undefined }
              : await generationHandler(generationSnapshot(pluginId, generation))
            const timeout = setTimeout(() => {
              const staged = generationTransactions.get(transactionId)
              if (staged === undefined) return
              generationTransactions.delete(transactionId)
              void staged.handle.rollback().catch(error => vite.config.logger.error(
                `[cordisx] failed to roll back abandoned plugin generation: ${error instanceof Error ? error.message : String(error)}`,
              ))
            }, 15_000)
            generationTransactions.set(transactionId, { handle: transaction, timeout, pluginId, moduleGeneration })
            return
          }
          const transaction = generationTransactions.get(transactionId)
          if (transaction === undefined) throw new Error('Unknown Vite plugin generation transaction')
          if (transaction.pluginId !== pluginId || transaction.moduleGeneration !== moduleGeneration) {
            throw new Error('Vite plugin generation transaction scope mismatch')
          }
          if (action === 'commit') {
            await transaction.handle.commit()
            pendingGenerations.get(pluginId)?.delete(moduleGeneration)
          } else if (action === 'rollback') await transaction.handle.rollback()
          else throw new Error('Unknown Vite plugin generation transaction action')
          clearTimeout(transaction.timeout)
          generationTransactions.delete(transactionId)
        })()
        void task.then(() => {
          client.send({ type: 'custom', event: 'cordisx:plugin-generation-transaction-result', data: { requestId, pluginId, moduleGeneration, transactionId, action } })
        }, error => {
          client.send({ type: 'custom', event: 'cordisx:plugin-generation-transaction-result', data: { requestId, pluginId, moduleGeneration, transactionId, action, error: error instanceof Error ? error.message : String(error) } })
        })
      })
      // Native pages must never receive Vite's window.location.reload fallback.
      const send = hot.send.bind(hot)
      hot.send = ((payload: unknown, data?: unknown) => {
        if (typeof payload === 'object' && payload !== null && 'type' in payload && payload.type === 'full-reload') {
          const timestamp = Date.now()
          const graph = vite.moduleGraph
          const seen = new Set<Parameters<typeof graph.invalidateModule>[0]>()
          for (const module of graph.idToModuleMap.values()) {
            if (module.url.includes('/@vite/') || module.url.endsWith('/@react-refresh')
              || module.id === '\0' + BOOT || module.id === '\0' + PREAMBLE || module.id === '\0' + REACT_PREPARE) continue
            graph.invalidateModule(module, seen, timestamp, true)
          }
          send({ type: 'custom', event: 'cordisx:restart-host', data: { timestamp } })
        } else if (typeof payload === 'string') send(payload, data)
        else send(payload as Parameters<typeof send>[0])
      }) as typeof hot.send
      vite.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', origin).pathname
        if (!pathname.startsWith(base)) { response.writeHead(404); response.end(); return }
        const map = sourceMaps.get(pathname)
        if (map !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
          response.end(map)
          return
        }
        const end = response.end.bind(response)
        response.end = ((chunk: unknown, ...args: unknown[]) => {
          if ((typeof chunk === 'string' || Buffer.isBuffer(chunk)) && String(response.getHeader('content-type')).includes('javascript')) {
            let source = String(chunk)
            if (pathname === base + '@vite/client') {
              const sourceMapIndex = source.lastIndexOf('\n//# sourceMappingURL=')
              source = sourceMapIndex < 0
                ? source + VITE_CLIENT_DISPOSER_SOURCE
                : source.slice(0, sourceMapIndex) + VITE_CLIENT_DISPOSER_SOURCE + source.slice(sourceMapIndex)
              chunk = source
              response.setHeader('content-length', Buffer.byteLength(source))
            }
            const match = /\n\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(source)
            if (match !== null) {
              const contents = Buffer.from(match[1]!, 'base64').toString('utf8')
              const mapPath = base + 'maps/' + createHash('sha256').update(contents).digest('hex') + '.map'
              sourceMaps.set(mapPath, contents)
              if (sourceMaps.size > 256) sourceMaps.delete(sourceMaps.keys().next().value!)
              chunk = source.slice(0, match.index) + '\n//# sourceMappingURL=' + origin + mapPath + '\n'
              response.setHeader('content-length', Buffer.byteLength(chunk as string))
            }
          }
          return Reflect.apply(end, response, [chunk, ...args])
        }) as typeof response.end
        next()
      })
    },
  }
  try {
    const initialGenerations = await Promise.all(initialConfig.plugins.filter(plugin => plugin.enabled).map(ensureGeneration))
    const roots = [...new Set(initialGenerations.map(item => item.root))]
    server = await createServer({
      configFile: false,
      root: workspaceRoot,
      cacheDir,
      base,
      publicDir: false,
      appType: 'custom',
      plugins: [integration, react()],
      ...(serverOptions.prebundleHostDependencies === true ? {
        optimizeDeps: {
          entries: [rendererPath, ...initialGenerations
            .filter(item => item.isolatedArtifactSource === undefined)
            .map(item => item.realEntry)],
          // react-markdown reaches these CommonJS leaves through ESM-only
          // dependency chains, so Vite's static scan cannot discover the
          // required default-export interop before the native renderer boots.
          include: ['debug', 'style-to-js'],
        },
      } : {}),
      resolve: {
        dedupe: ['react', 'react-dom'],
        alias: [
          { find: /^react$/, replacement: path.join(reactPackageRoot, 'index.js') },
          { find: /^react\/(.+)$/, replacement: `${normalizePath(reactPackageRoot)}/$1` },
          { find: /^react-dom$/, replacement: path.join(reactDomPackageRoot, 'index.js') },
          { find: /^react-dom\/(.+)$/, replacement: `${normalizePath(reactDomPackageRoot)}/$1` },
        ],
      },
      server: {
        host: '127.0.0.1', port, strictPort: true, origin,
        preTransformRequests: false,
        cors: { origin: ['null', 'app://-', origin] },
        ws: { host: '127.0.0.1', clientPort: port, protocol: 'ws' },
        fs: { allow: [path.resolve(cliRoot, '../..'), workspaceRoot, ...roots, ...config.plugins.map(item => path.dirname(item.entry))] },
        watch: {
          ignoreInitial: true,
          ignored: [...(sourceMode ? [`${generatedRoot}**`] : []), '**/node_modules/**', '**/.git/**'],
        },
      },
      clearScreen: false,
    })
    const watcherReady = new Promise<void>(resolve => server.watcher.once('ready', resolve))
    await server.listen()
    server.watcher.add(initialGenerations.flatMap(generation => generation.watchFiles))
    await watcherReady
    if (serverOptions.prebundleHostDependencies === true) await waitForDependencyOptimization()
  } catch (error) {
    await server!?.close()
    throw error
  }
  return {
    url: origin + base,
    cacheDir,
    async buildBootstrap(nextConfig, nextOptions) {
      config = nextConfig
      options = nextOptions
      await Promise.all(config.plugins.filter(plugin => plugin.enabled).map(ensureGeneration))
      await compiledConfig()
      await Promise.all(config.plugins.filter(plugin => plugin.enabled).map(validatePlugin))
      // CDP installs only this stable entry. Source modules and updates use Vite.
      return `if (!globalThis.__cordisxViteBoot) { globalThis.__cordisxViteBoot = (async () => { await import(${JSON.stringify(url(PREAMBLE))}); const boot = await import(${JSON.stringify(url(BOOT))}); return await boot.start(); })(); globalThis.__cordisxViteBoot.catch(error => { console.error('[cordisx] Vite bootstrap failed', error); }); }`
    },
    async synchronizePluginGenerations(handler) {
      generationHandler = handler
      for (const plugin of config.plugins.filter(plugin => plugin.enabled)) {
        const generation = await ensureGeneration(plugin)
        const transaction = await handler(generationSnapshot(plugin.id, generation))
        await transaction.commit()
      }
    },
    async close() {
      try {
        await waitForDependencyOptimization()
        await server.close()
      } finally {
        sourceMaps.clear()
        generations.clear()
        pendingGenerations.clear()
        for (const transaction of generationTransactions.values()) {
          clearTimeout(transaction.timeout)
          await transaction.handle.rollback().catch(() => undefined)
        }
        generationTransactions.clear()
        fileHashes.clear()
      }
    },
  }
}
