import type { PluginRuntimeManifestV16 } from '@cordisx/protocol/plugin-manifest/v16'
import type { PluginRuntimeManifestV15 } from '@cordisx/protocol/plugin-manifest/v15'
import type { PluginRuntimeManifestV14 } from '@cordisx/protocol/plugin-manifest/v14'
import type { CordisXPluginManifestV11 } from '../usage-permissions.js'
import type { CordisXPluginManifestV10 } from '../extension-point-interaction-permissions.js'
import type { CordisXPluginManifestV12, CordisXPluginManifestV13 } from '../runtime-exact-request-permissions.js'
import type {
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
  CordisXPluginManifestV9,
} from '../permission-contracts.js'
import { createHash } from 'node:crypto'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../plugin-lifecycle-contracts.js'
import type { CordisXConfig } from './config.js'
import { CdpPluginLifecycleRuntime } from './cdp.js'
import type { EntityTemplatePayload } from './entity-directory.js'
import { assertNoPrivateReactBundle, cordisXReactVirtualModules } from './react-virtual-modules.js'
import { buildProductionPluginGraph, type BuiltPluginGenerationArtifact } from './production-plugin-build.js'
import { localDevelopmentManifestIdentity } from './development-manifest-identity.js'
import { readRendererOnlyPackage } from './development-package-metadata.js'
import { readPluginDocuments } from './plugin-documents.js'
import { pluginDocumentPayload } from './plugin-package-documents.js'
const WATCH_INTERVAL_MS = 200
const DEBOUNCE_MS = 120
const ROLLBACK_RETRY_MS = 750
const IGNORED_DIRECTORIES = new Set(['.git', '.next', 'coverage', 'dist', 'node_modules'])
const MAX_DIAGNOSTIC_LENGTH = 4_000
function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= MAX_DIAGNOSTIC_LENGTH ? message : `${message.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`
}

export interface LocalDevelopmentBuild {
  readonly id: string
  readonly version: string
  readonly entry: string
  readonly sourceRoot: string
  readonly identitySource: string
  readonly digest: `sha256:${string}`
  readonly moduleFactorySource?: string
  readonly runtimeArtifactSource?: string
  readonly browserArtifact?: BuiltPluginGenerationArtifact
  readonly watchFiles: readonly string[]
  readonly entityTemplates: readonly EntityTemplatePayload[]
  readonly documents?: readonly import('@cordisx/protocol/plugin-documents/v1').PluginDocumentReadbackV1[]
  readonly readme?: string
  readonly readmes?: Readonly<Record<string, string>>
  readonly manifest?:
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10
    | CordisXPluginManifestV11
    | CordisXPluginManifestV12
    | CordisXPluginManifestV13
    | PluginRuntimeManifestV16
    | PluginRuntimeManifestV14
    | PluginRuntimeManifestV15
}

interface LocalDevelopmentBuildOptions {
  /** Inline by default for ordinary local development and real-App diagnostics. */
  readonly sourcemap?: 'inline' | false
  /** Playground dev:ui uses the same browser ESM graph as production. */
  readonly browserGraphOnly?: boolean
}

interface LocalDevelopmentEntry {
  readonly id: string
  readonly entry: string
  readonly sourceRoot: string
  readonly identitySource: string
}

function pluginId(entry: string): string {
  const name = path.basename(entry, path.extname(entry))
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 96)
  return name === '' || name === 'host' || name.startsWith('cordisx.') ? 'local-plugin' : name
}

export async function findPackageRoot(entry: string): Promise<string> {
  let directory = path.dirname(entry)
  while (true) {
    const manifestPath = path.join(directory, 'package.json')
    if (
      await access(manifestPath).then(() => true).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      })
    ) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return path.dirname(entry)
    directory = parent
  }
}

export interface LocalDevelopmentPackageInfo {
  readonly root: string
  readonly version: string
  /** Exact renderer-only package inputs that must invalidate a development generation. */
  readonly packageFiles: readonly string[]
  readonly entityTemplates: readonly EntityTemplatePayload[]
  readonly documents: readonly import('@cordisx/protocol/plugin-documents/v1').PluginDocumentReadbackV1[]
  readonly manifest?:
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10
    | CordisXPluginManifestV11
    | CordisXPluginManifestV12
    | CordisXPluginManifestV13
    | PluginRuntimeManifestV16
    | PluginRuntimeManifestV14
    | PluginRuntimeManifestV15
}

export async function localDevelopmentPackageInfo(entry: string): Promise<LocalDevelopmentPackageInfo> {
  const root = await findPackageRoot(entry)
  const [manifest, rendererPackage]: readonly [
    { readonly version?: unknown },
    Awaited<ReturnType<typeof readRendererOnlyPackage>>,
  ] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8')
      .then(text => JSON.parse(text) as { readonly version?: unknown })
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw error
      }),
    readRendererOnlyPackage(root),
  ])
  const documentSet = await readPluginDocuments(entry, rendererPackage.manifest?.id ?? pluginId(entry), root)
  return {
    root,
    documents: documentSet.documents,
    version: typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
      ? manifest.version
      : '0.0.0-local-dev',
    packageFiles: [...rendererPackage.files, path.join(root, 'cordisx-documents.json'), ...documentSet.files],
    entityTemplates: rendererPackage.entityTemplates,
    ...(rendererPackage.manifest === undefined ? {} : { manifest: rendererPackage.manifest }),
  }
}

async function resolveLocalDevelopmentEntry(rawEntry: string): Promise<LocalDevelopmentEntry> {
  const entry = path.resolve(rawEntry)
  await access(entry)
  const root = await findPackageRoot(entry)
  const id = await localDevelopmentManifestIdentity(root) ?? pluginId(entry)
  const sourceKey = createHash('sha256').update(entry).digest('hex').slice(0, 24)
  return {
    id,
    entry,
    sourceRoot: root,
    identitySource: `file:///cordisx-local-dev/${sourceKey}/${id}.js`,
  }
}

/** Host-private stable owner identity without compiling the local plugin candidate. */
export async function localDevelopmentPluginIdentity(
  rawEntry: string,
): Promise<{ readonly id: string; readonly source: string }> {
  const resolved = await resolveLocalDevelopmentEntry(rawEntry)
  return { id: resolved.id, source: resolved.identitySource }
}

async function readReadmes(root: string): Promise<{
  readonly default?: string
  readonly localized: Readonly<Record<string, string>>
  readonly files: readonly string[]
}> {
  const names = await readdir(root).catch(() => [])
  const files = names
    .filter(name => /^README(?:\.[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)?\.(?:md|markdown)$/iu.test(name))
    .map(name => path.join(root, name))
    .sort()
  const values = await Promise.all(files.map(async file => {
    const match = /^README(?:\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*))?\.(?:md|markdown)$/iu.exec(path.basename(file))
    return {
      file,
      locale: match?.[1]?.toLocaleLowerCase(),
      source: await readFile(file, 'utf8'),
    }
  }))
  const fallback = values.find(value => value.locale === undefined)?.source
  return {
    ...(fallback === undefined ? {} : { default: fallback }),
    localized: Object.fromEntries(
      values.flatMap(value => value.locale === undefined ? [] : [[value.locale, value.source]]),
    ),
    files,
  }
}

function absoluteInputs(root: string, inputs: Readonly<Record<string, unknown>>): readonly string[] {
  // esbuild reports Host-provided virtual modules in the metafile too. They
  // have no filesystem node and must never enter a file watcher/import graph.
  return Object.keys(inputs).flatMap(input =>
    input.startsWith('cordisx-shared-react:')
      ? []
      : [path.resolve(root, input)]
  )
}

function absoluteGraphInputs(inputs: readonly string[]): readonly string[] {
  return inputs.filter(input => path.isAbsolute(input) && !input.includes('\0'))
}

/** Build one immutable local-dev candidate and return its complete esbuild input graph. */
export async function buildLocalDevelopmentPlugin(
  rawEntry: string,
  options: LocalDevelopmentBuildOptions = {},
): Promise<LocalDevelopmentBuild> {
  const entry = path.resolve(rawEntry)
  await access(entry)
  const { root, version, packageFiles, entityTemplates, manifest, documents } = await localDevelopmentPackageInfo(entry)
  const id = manifest?.id ?? pluginId(entry)
  const common = {
    absWorkingDir: root,
    bundle: true,
    platform: 'browser' as const,
    target: ['chrome120'],
    sourcemap: options.sourcemap ?? 'inline',
    metafile: true,
    loader: { '.svg': 'text' as const, '.css': 'text' as const, '.png': 'dataurl' as const },
    jsx: 'automatic' as const,
    jsxImportSource: 'cordisx/react',
    plugins: [cordisXReactVirtualModules(entry)],
    write: false,
    logLevel: 'silent' as const,
  }
  const [moduleResult, browserArtifact, readmes] = await Promise.all([
    options.browserGraphOnly === true
      ? undefined
      : build({ entryPoints: [entry], format: 'iife', globalName: '__cordisxPluginModule', ...common }),
    options.browserGraphOnly === true ? buildProductionPluginGraph(root, entry) : undefined,
    readReadmes(root),
  ])
  const packageSource = { files: packageFiles, entityTemplates, ...(manifest === undefined ? {} : { manifest }) }
  if (packageSource.manifest !== undefined && packageSource.manifest.id !== id) {
    throw new Error('local development runtime manifest id does not match the selected entry')
  }
  if (moduleResult !== undefined && moduleResult.metafile === undefined) {
    throw new Error('local development build produced no dependency metadata')
  }
  if (moduleResult?.metafile !== undefined) {
    assertNoPrivateReactBundle(moduleResult.metafile, `local development plugin ${id}`)
  }
  const moduleOutput = moduleResult?.outputFiles?.[0]
  if (moduleOutput === undefined && browserArtifact === undefined) {
    throw new Error('local development build produced no browser artifact')
  }
  // Both an existing renderer and a future bootstrap must instantiate the
  // exact same module factory with the Host-issued Plugin Console facade.  Do
  // not evaluate a module object eagerly in the CDP global console.
  const runtimeArtifactSource = moduleOutput === undefined
    ? undefined
    : `globalThis.__cordisxPendingPluginModuleFactoryV1 = (console) => {\n${moduleOutput.text}\nreturn __cordisxPluginModule;\n};\n`
  const digestHash = createHash('sha256')
    .update(moduleOutput?.text ?? '')
    .update('\0')
    .update(runtimeArtifactSource ?? '')
    .update('\0')
    .update(version)
    .update('\0')
    .update(readmes.default ?? '')
    .update('\0')
    .update(JSON.stringify(readmes.localized))
    .update('\0')
    .update(JSON.stringify(packageSource.entityTemplates))
    .update('\0')
    .update(JSON.stringify(packageSource.manifest ?? null))
  const documentsText = pluginDocumentPayload(documents)
  if (documentsText !== undefined) digestHash.update('\0plugin-documents\0').update(documentsText)
  if (browserArtifact !== undefined) {
    digestHash.update('\0browser-artifact\0').update(JSON.stringify(browserArtifact.manifest))
    for (const [file, contents] of [...browserArtifact.files].sort(([left], [right]) => left.localeCompare(right))) {
      digestHash.update('\0browser-file\0').update(file).update('\0').update(contents)
    }
  }
  const digest = `sha256:${digestHash.digest('hex')}` as const
  const sourceKey = createHash('sha256').update(entry).digest('hex').slice(0, 24)
  return {
    id,
    version,
    entry,
    sourceRoot: root,
    identitySource: `file:///cordisx-local-dev/${sourceKey}/${id}.js`,
    digest,
    ...(moduleOutput === undefined ? {} : { moduleFactorySource: moduleOutput.text }),
    ...(runtimeArtifactSource === undefined ? {} : { runtimeArtifactSource }),
    ...(browserArtifact === undefined ? {} : { browserArtifact }),
    watchFiles: [
      ...new Set([
        entry,
        path.join(root, 'package.json'),
        ...packageSource.files,
        ...readmes.files,
        ...absoluteInputs(root, moduleResult?.metafile?.inputs ?? {}),
        ...absoluteGraphInputs(browserArtifact?.inputModules ?? []),
      ]),
    ].sort(),
    entityTemplates: packageSource.entityTemplates,
    documents,
    ...(packageSource.manifest === undefined ? {} : { manifest: packageSource.manifest }),
    ...(readmes.default === undefined ? {} : { readme: readmes.default }),
    ...(Object.keys(readmes.localized).length === 0 ? {} : {
      readmes: {
        ...(readmes.default === undefined ? {} : { default: readmes.default }),
        ...readmes.localized,
      },
    }),
  }
}

async function sourceFiles(root: string): Promise<readonly string[]> {
  const output: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) output.push(target)
    }
  }
  await visit(root)
  return output
}

async function fingerprint(files: readonly string[]): Promise<string> {
  const values = await Promise.all(
    [...new Set(files)].sort().map(async file => {
      try {
        const value = await stat(file)
        return `${file}\0${value.size}\0${value.mtimeMs}`
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${file}\0missing`
        throw error
      }
    }),
  )
  return createHash('sha256').update(values.join('\n')).digest('hex')
}

export interface LocalDevelopmentControllerOptions {
  readonly entry: string
  readonly runtimeGeneration: string
  readonly initialConfig: CordisXConfig
  readonly runtime: Pick<
    CdpPluginLifecycleRuntime,
    | 'currentRegistryEpoch'
    | 'cancelPreparation'
    | 'prepare'
    | 'stage'
    | 'publish'
    | 'complete'
    | 'finalize'
    | 'rollback'
    | 'updateDevelopmentStatus'
  >
  readonly rebuildBootstrap: (
    config: CordisXConfig,
    activation: CordisXPluginActivationRecordV1,
    registryEpoch: number,
  ) => Promise<string>
  readonly setBootstrap: (source: string) => void
  readonly stdout: (line: string) => void
}

interface PendingLocalDevelopmentRollback {
  readonly transactionId: string
  restored?: Awaited<ReturnType<CdpPluginLifecycleRuntime['rollback']>>
}

/** Single-flight, attempt-fenced local development generation coordinator. */
export class LocalDevelopmentController {
  private readonly entry: string
  private readonly pluginId: string
  private readonly sourceRoot: string
  private readonly identitySource: string
  private active: CordisXPluginActivationRecordV1
  private lastGoodConfig: CordisXConfig
  private watchFiles: readonly string[] = []
  private lastFingerprint = ''
  private lastSuccessfulAt: string | undefined
  private desiredAttempt = 0
  private running = false
  private stopped = true
  private pendingRollback: PendingLocalDevelopmentRollback | undefined
  private watchEpoch = 0
  private starting: Promise<void> | undefined
  private polling: Promise<void> | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private poller: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined

  private constructor(private readonly options: LocalDevelopmentControllerOptions, resolved: LocalDevelopmentEntry) {
    this.entry = resolved.entry
    this.pluginId = resolved.id
    this.sourceRoot = resolved.sourceRoot
    this.identitySource = resolved.identitySource
    this.watchFiles = [resolved.entry, path.join(resolved.sourceRoot, 'package.json')]
    this.lastGoodConfig = structuredClone(options.initialConfig)
    this.active = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'development',
      revision: 0,
      lastGoodRevision: 0,
      runtimeGeneration: options.runtimeGeneration,
      plugins: [],
    }
  }

  static async create(options: LocalDevelopmentControllerOptions): Promise<LocalDevelopmentController> {
    return new LocalDevelopmentController(options, await resolveLocalDevelopmentEntry(options.entry))
  }

  private state(state: CordisXLocalDevelopmentSnapshot['state'], error?: string): CordisXLocalDevelopmentSnapshot {
    return {
      origin: 'local-dev',
      pluginId: this.pluginId,
      sourcePath: this.entry,
      state,
      ...(this.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: this.lastSuccessfulAt }),
      ...(error === undefined ? {} : { error }),
    }
  }

  private async currentFingerprint(): Promise<string> {
    return await fingerprint([...this.watchFiles, ...await sourceFiles(this.sourceRoot)])
  }

  private async restoreLastGoodBootstrap(
    restored: Awaited<ReturnType<CdpPluginLifecycleRuntime['rollback']>>,
  ): Promise<void> {
    this.active = structuredClone(restored.active)
    const source = await this.options.rebuildBootstrap(this.lastGoodConfig, this.active, restored.registryEpoch)
    this.options.setBootstrap(source)
  }

  private async finishPendingRollback(transactionId: string): Promise<void> {
    const pending: PendingLocalDevelopmentRollback = this.pendingRollback?.transactionId === transactionId
      ? this.pendingRollback
      : { transactionId }
    this.pendingRollback = pending
    pending.restored ??= await this.options.runtime.rollback(transactionId)
    await this.restoreLastGoodBootstrap(pending.restored)
    if (this.pendingRollback === pending) {
      this.pendingRollback = undefined
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  private armRetry(expectedTransactionId?: string): void {
    if (this.stopped || this.retryTimer !== undefined) return
    const epoch = this.watchEpoch
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.stopped || epoch !== this.watchEpoch) return
      if (expectedTransactionId === undefined) {
        if (this.pendingRollback !== undefined) return
      } else if (this.pendingRollback?.transactionId !== expectedTransactionId) return
      // Re-enter the normal single-flight drain. A pending transaction is
      // resolved before the latest source fingerprint can build/publish.
      this.schedule()
    }, ROLLBACK_RETRY_MS)
  }

  private async projectStatus(
    state: CordisXLocalDevelopmentSnapshot['state'],
    error?: string,
  ): Promise<void> {
    try {
      await this.options.runtime.updateDevelopmentStatus(this.state(state, error))
    } catch (projectionError) {
      this.options.stdout(`[cordisx] local-dev status projection failed: ${diagnostic(projectionError)}`)
    }
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.desiredAttempt += 1
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.drain().catch(error => {
        this.options.stdout(`[cordisx] local-dev drain failed: ${diagnostic(error)}`)
      })
    }, DEBOUNCE_MS)
  }

  private async poll(epoch: number): Promise<void> {
    const next = await this.currentFingerprint()
    if (this.stopped || epoch !== this.watchEpoch) return
    if (next === this.lastFingerprint) return
    this.lastFingerprint = next
    this.schedule()
  }

  private armPoller(epoch: number): void {
    if (this.stopped || epoch !== this.watchEpoch) return
    this.poller = setTimeout(() => {
      this.poller = undefined
      let polling!: Promise<void>
      polling = (async (): Promise<void> => {
        try {
          await this.poll(epoch)
        } catch (error) {
          this.options.stdout(`[cordisx] local-dev watch failed: ${String(error)}`)
        } finally {
          if (this.polling === polling) this.polling = undefined
          this.armPoller(epoch)
        }
      })()
      this.polling = polling
    }, WATCH_INTERVAL_MS)
  }

  async start(): Promise<void> {
    if (!this.stopped) return await this.starting
    this.stopped = false
    const epoch = ++this.watchEpoch
    const starting = (async (): Promise<void> => {
      const initialFingerprint = await this.currentFingerprint()
      if (this.stopped || epoch !== this.watchEpoch) return
      this.lastFingerprint = initialFingerprint
      this.schedule()
      this.armPoller(epoch)
    })()
    this.starting = starting
    try {
      await starting
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.watchEpoch += 1
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    if (this.poller !== undefined) clearTimeout(this.poller)
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.debounce = undefined
    this.poller = undefined
    this.retryTimer = undefined
    await Promise.all([this.starting, this.polling])
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10))
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (!this.stopped) {
        const attempt = this.desiredAttempt
        await this.attempt(attempt)
        if (attempt === this.desiredAttempt) break
      }
    } finally {
      this.running = false
    }
  }

  private async attempt(attempt: number): Promise<void> {
    await this.projectStatus('building')
    if (this.pendingRollback !== undefined) {
      const transactionId = this.pendingRollback.transactionId
      try {
        await this.finishPendingRollback(transactionId)
      } catch (error) {
        const message = `pending rollback ${transactionId} failed: ${diagnostic(error)}`
        await this.projectStatus('failed', message)
        this.options.stdout(`[cordisx] local-dev ${message}`)
        this.armRetry(transactionId)
        return
      }
      if (attempt !== this.desiredAttempt || this.stopped) return
    }
    this.options.stdout(`[cordisx] local-dev build ${attempt}: ${this.entry}`)
    let build: LocalDevelopmentBuild
    try {
      build = await buildLocalDevelopmentPlugin(this.entry)
      this.watchFiles = build.watchFiles
    } catch (error) {
      const message = diagnostic(error)
      await this.projectStatus('failed', message)
      this.options.stdout(`[cordisx] local-dev build failed; last-good retained: ${message}`)
      return
    }
    if (attempt !== this.desiredAttempt || this.stopped) return
    const previous = this.active
    const prior = previous.plugins.find(item => item.id === build.id)
    if (prior?.digest === build.digest) {
      this.lastSuccessfulAt = new Date().toISOString()
      await this.projectStatus('ready')
      return
    }
    if (previous.plugins.length > 0 && prior === undefined) {
      const message = `local development plugin id changed from ${previous.plugins[0]!.id} to ${build.id}`
      await this.projectStatus('failed', message)
      this.options.stdout(`[cordisx] ${message}`)
      return
    }
    const transactionId = `local-dev-${attempt}-${build.digest.slice(-12)}`
    const moduleGeneration = `${build.id}-local-dev-${attempt}-${build.digest.slice(-12)}`
    const item = {
      id: build.id,
      version: build.version,
      digest: build.digest,
      moduleGeneration,
      enabled: true,
      dependencies: [],
    }
    const candidate: CordisXPluginActivationRecordV1 = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'candidate',
      transactionId,
      profileId: previous.profileId,
      revision: previous.revision + 1,
      lastGoodRevision: previous.revision,
      runtimeGeneration: previous.runtimeGeneration,
      plugins: [item],
    }
    const expectedRegistryEpoch = this.options.runtime.currentRegistryEpoch()
    const successfulAt = new Date().toISOString()
    const readyState: CordisXLocalDevelopmentSnapshot = {
      origin: 'local-dev',
      pluginId: build.id,
      sourcePath: this.entry,
      state: 'ready',
      lastSuccessfulAt: successfulAt,
    }
    const bootstrapConfig: CordisXConfig = {
      version: 1,
      rootDir: build.sourceRoot,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{
        id: build.id,
        entry: build.entry,
        source: build.identitySource,
        enabled: true,
        config: {},
        revision: 0,
        package: {
          version: build.version,
          digest: build.digest,
          moduleGeneration,
          dependencies: [],
        },
        ...(build.moduleFactorySource === undefined ? {} : { moduleFactorySource: build.moduleFactorySource }),
        ...(build.manifest === undefined ? {} : { manifest: build.manifest }),
        development: readyState,
        ...(build.readme === undefined ? {} : { readme: build.readme }),
        ...(build.readmes === undefined ? {} : { readmes: build.readmes }),
        ...(build.documents === undefined ? {} : { documents: build.documents }),
      }],
    }
    let nextBootstrap: string
    try {
      nextBootstrap = await this.options.rebuildBootstrap(bootstrapConfig, {
        ...candidate,
        recordKind: 'active',
        lastGoodRevision: candidate.revision,
      }, expectedRegistryEpoch + 1)
    } catch (error) {
      const message = diagnostic(error)
      await this.projectStatus('failed', message)
      this.options.stdout(`[cordisx] local-dev bootstrap build failed; last-good retained: ${message}`)
      return
    }
    if (attempt !== this.desiredAttempt || this.stopped) {
      return
    }
    let prepared = false
    let retryPreparation = false
    try {
      let fence: ReturnType<CdpPluginLifecycleRuntime['prepare']>
      try {
        fence = this.options.runtime.prepare(transactionId)
      } catch (error) {
        retryPreparation = true
        throw error
      }
      prepared = true
      if (fence.expectedRegistryEpoch !== expectedRegistryEpoch) {
        await this.options.runtime.cancelPreparation(transactionId)
        prepared = false
        this.schedule()
        return
      }
      await this.options.runtime.stage({
        transactionId,
        ...fence,
        afterRegistryEpoch: fence.expectedRegistryEpoch + 1,
        operation: prior === undefined ? 'install' : 'update',
        previous,
        candidate,
        targetId: build.id,
        affectedPluginIds: [build.id],
        ...(build.runtimeArtifactSource === undefined ? {} : { runtimeArtifactSource: build.runtimeArtifactSource }),
        developmentPackage: {
          id: build.id,
          version: build.version,
          digest: build.digest,
          identitySource: this.identitySource,
          development: readyState,
          ...(build.manifest === undefined ? {} : { manifest: build.manifest }),
          ...(build.readme === undefined ? {} : { readme: build.readme }),
          ...(build.readmes === undefined ? {} : { readmes: build.readmes }),
          ...(build.documents === undefined ? {} : { documents: build.documents }),
        },
      })
      if (attempt !== this.desiredAttempt || this.stopped) {
        this.pendingRollback = { transactionId }
        try {
          await this.finishPendingRollback(transactionId)
        } catch (error) {
          const message = `pending rollback ${transactionId} failed: ${diagnostic(error)}`
          await this.projectStatus('failed', message)
          this.options.stdout(`[cordisx] local-dev ${message}`)
          this.armRetry(transactionId)
        }
        return
      }
      await this.options.runtime.publish(transactionId)
      await this.options.runtime.complete(transactionId)
      await this.options.runtime.finalize(transactionId)
      prepared = false
      const { transactionId: _transactionId, ...committed } = candidate
      this.active = { ...committed, recordKind: 'active', lastGoodRevision: candidate.revision }
      this.lastGoodConfig = structuredClone(bootstrapConfig)
      this.lastSuccessfulAt = successfulAt
      this.options.setBootstrap(nextBootstrap)
      await this.projectStatus('ready')
      this.options.stdout(`[cordisx] local-dev generation ready: ${build.id} ${moduleGeneration}`)
    } catch (error) {
      let message = diagnostic(error)
      if (prepared) {
        this.pendingRollback = { transactionId }
        try {
          await this.finishPendingRollback(transactionId)
        } catch (rollbackError) {
          message = `${message}; rollback failed: ${diagnostic(rollbackError)}`
          this.armRetry(transactionId)
        }
      }
      if (retryPreparation) this.armRetry()
      await this.projectStatus('failed', message)
      this.options.stdout(`[cordisx] local-dev activation failed; last-good retained: ${message}`)
    }
  }
}
