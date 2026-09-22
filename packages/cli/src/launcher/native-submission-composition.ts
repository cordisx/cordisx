import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import { nativeModelProviderCatalog } from './native-model-provider-catalog.js'
import { createNativeProviderCredentialBroker } from './native-provider-credential-broker.js'
import { nativeSubmissionCredentialBroker } from './native-submission-credentials.js'
import { createNativeSubmissionController, type NativeSubmissionController } from './native-submission-controller.js'
import {
  createNativeSubmissionCdpAuthority,
  type NativeSubmissionCdpAuthority,
} from './native-submission-cdp-channel.js'
import { startNativeSubmissionControlServer } from './native-submission-control-server.js'
import type { NativeResourceTransform } from './native-predispatch-interception.js'
import { readNativeSubmissionResources } from './native-app-resources.js'
import {
  analyzeNativeSubmissionTransforms,
  type NativeScriptResource,
  type NativeSubmissionTransformAnalysis,
} from './native-submission-structure.js'
import {
  discoverNativeAccountCapability,
  discoverNativeAccountCapabilityFromSyntax,
} from './native-account-structure.js'
import type { NativeAccountCapabilityDescriptor } from '../native-account-capability.js'
import { legacyNativeSubmissionResources } from './native-submission-legacy-resources.js'
import { codexConfigModelProviders } from './codex-config-model-providers.js'
import { combinedNativeModelProviderCatalog } from './native-model-provider-catalog.js'

const execFileAsync = promisify(execFile)
const NATIVE_SUBMISSION_CACHE_SCHEMA = 1
/** Bump whenever structural discovery or its generated transform contract changes. */
const NATIVE_SUBMISSION_ANALYZER_VERSION = 1
const SHA256 = /^[a-f0-9]{64}$/u

interface CachedNativeTransform {
  readonly url: string
  readonly sha256: string
  readonly source: string
  readonly sourceSha256: string
  readonly acknowledgementExpression: string
  readonly fenceExpression: string
  readonly requiredForDocumentReady: boolean
}

interface NativeSubmissionAnalysisCache {
  readonly schemaVersion: 1
  readonly analyzerVersion: number
  readonly identity: string
  readonly transforms: readonly CachedNativeTransform[]
  readonly accountCapability?: NativeAccountCapabilityDescriptor
}

export interface NativeSubmissionInstallation {
  readonly authority: NativeSubmissionCdpAuthority
  readonly transforms: readonly NativeResourceTransform[]
  readonly accountCapability?: NativeAccountCapabilityDescriptor
}
export interface NativeSubmissionComposition {
  readonly installation: NativeSubmissionInstallation
  readonly environment: Readonly<Record<string, string>>
  close(): Promise<void>
}
export interface NativeSubmissionBootstrap {
  readonly environment: Readonly<Record<string, string>>
  complete(
    activation: Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>,
    codexHome: string,
    options?: Readonly<{ defaultProviderId?: string }>,
  ): Promise<NativeSubmissionComposition>
  close(): Promise<void>
}
export function nativeAppServerIntermediaryPath(): string {
  return fileURLToPath(new URL('../../assets/launcher/native-app-server-intermediary.mjs', import.meta.url))
}

export function nativeSubmissionTransformsForApp(
  appVersion: string,
  buildNumber: string,
  resources: readonly NativeScriptResource[],
): readonly NativeResourceTransform[] {
  return nativeSubmissionTransformAnalysisForApp(appVersion, buildNumber, resources).transforms
}

function nativeSubmissionTransformAnalysisForApp(
  appVersion: string,
  buildNumber: string,
  resources: readonly NativeScriptResource[],
): NativeSubmissionTransformAnalysis | Readonly<{ transforms: readonly NativeResourceTransform[] }> {
  try {
    const legacy = legacyNativeSubmissionResources(resources)
    return legacy === undefined ? analyzeNativeSubmissionTransforms(resources) : { transforms: legacy }
  } catch (error) {
    throw new Error(
      `Native submission incompatible with Codex Desktop ${appVersion} (${buildNumber}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function defaultNativeSubmissionCacheDirectory(): string {
  return path.join(os.homedir(), 'Library', 'Caches', 'CordisX', 'native-submission')
}

function cacheIdentity(
  appVersion: string,
  buildNumber: string,
  resources: readonly NativeScriptResource[],
): string {
  return digest(JSON.stringify({
    analyzerVersion: NATIVE_SUBMISSION_ANALYZER_VERSION,
    appVersion,
    buildNumber,
    resources: resources.map(resource => ({ url: resource.url, sha256: digest(resource.source) })),
  }))
}

function validCachedTransform(value: unknown, resources: readonly NativeScriptResource[]): value is CachedNativeTransform {
  if (!value || typeof value !== 'object') return false
  const transform = value as CachedNativeTransform
  const resource = resources.find(candidate => candidate.url === transform.url)
  return resource !== undefined
    && transform.sha256 === digest(resource.source)
    && typeof transform.source === 'string'
    && SHA256.test(transform.sourceSha256)
    && digest(transform.source) === transform.sourceSha256
    && typeof transform.acknowledgementExpression === 'string'
    && transform.acknowledgementExpression.length > 0
    && typeof transform.fenceExpression === 'string'
    && transform.fenceExpression.length > 0
    && typeof transform.requiredForDocumentReady === 'boolean'
}

function validAccountCapability(
  value: unknown,
  resources: readonly NativeScriptResource[],
): value is NativeAccountCapabilityDescriptor {
  if (!value || typeof value !== 'object') return false
  const capability = value as NativeAccountCapabilityDescriptor
  return resources.some(resource => resource.url === capability.module)
    && typeof capability.exportName === 'string' && capability.exportName.length > 0
}

function materializeCachedTransforms(
  cached: readonly CachedNativeTransform[],
): readonly NativeResourceTransform[] {
  return cached.map(record => Object.freeze({
    url: record.url,
    sha256: record.sha256,
    requiredForDocumentReady: record.requiredForDocumentReady,
    transform: (observed: string) => {
      if (digest(observed) !== record.sha256) {
        throw new Error(`Native resource changed after capability discovery: ${record.url}`)
      }
      return {
        source: record.source,
        anchorMatches: 1,
        acknowledgementExpression: record.acknowledgementExpression,
        fenceExpression: record.fenceExpression,
      }
    },
  }))
}

async function readAnalysisCache(
  file: string,
  identity: string,
  resources: readonly NativeScriptResource[],
): Promise<NativeSubmissionAnalysisCache | undefined> {
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      return undefined
    }
    const value = JSON.parse(await readFile(file, 'utf8')) as NativeSubmissionAnalysisCache
    if (
      value.schemaVersion !== NATIVE_SUBMISSION_CACHE_SCHEMA
      || value.analyzerVersion !== NATIVE_SUBMISSION_ANALYZER_VERSION
      || value.identity !== identity
      || !Array.isArray(value.transforms) || value.transforms.length === 0
      || !value.transforms.every(transform => validCachedTransform(transform, resources))
      || (value.accountCapability !== undefined && !validAccountCapability(value.accountCapability, resources))
    ) return undefined
    return value
  } catch {
    return undefined
  }
}

async function writeAnalysisCache(file: string, value: NativeSubmissionAnalysisCache): Promise<void> {
  const directory = path.dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
    throw new Error('Unsafe native submission cache directory')
  }
  await chmod(directory, 0o700)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

function captureTransforms(
  transforms: readonly NativeResourceTransform[],
  resources: readonly NativeScriptResource[],
): readonly CachedNativeTransform[] {
  return transforms.map(transform => {
    const resource = resources.find(candidate => candidate.url === transform.url)
    if (resource === undefined) throw new Error(`Native transform resource is unavailable: ${transform.url}`)
    const result = transform.transform(resource.source)
    if (result.anchorMatches !== 1) throw new Error(`Native transform is not exact: ${transform.url}`)
    return {
      url: transform.url,
      sha256: transform.sha256,
      source: result.source,
      sourceSha256: digest(result.source),
      acknowledgementExpression: result.acknowledgementExpression,
      fenceExpression: result.fenceExpression,
      requiredForDocumentReady: transform.requiredForDocumentReady !== false,
    }
  })
}

async function nativeSubmissionTransforms(contents: string, cacheDirectory: string): Promise<{
  transforms: readonly NativeResourceTransform[]
  accountCapability?: NativeAccountCapabilityDescriptor
}> {
  const info = path.join(contents, 'Info.plist')
  const [appVersion, buildNumber] = await Promise.all([
    execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info]),
    execFileAsync('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', info]),
  ])
  const identity = {
    appVersion: appVersion.stdout.trim(),
    buildNumber: buildNumber.stdout.trim(),
  }
  const resources = readNativeSubmissionResources(contents)
  const analysisIdentity = cacheIdentity(identity.appVersion, identity.buildNumber, resources)
  const cacheFile = path.join(cacheDirectory, `${analysisIdentity}.json`)
  const cached = await readAnalysisCache(cacheFile, analysisIdentity, resources)
  if (cached !== undefined) {
    return {
      transforms: materializeCachedTransforms(cached.transforms),
      ...(cached.accountCapability === undefined ? {} : { accountCapability: cached.accountCapability }),
    }
  }
  const discovered = nativeSubmissionTransformAnalysisForApp(identity.appVersion, identity.buildNumber, resources)
  const captured = captureTransforms(discovered.transforms, resources)
  const initial = resources.find(resource => resource.url.includes('/app-initial-'))!
  let accountCapability: NativeAccountCapabilityDescriptor | undefined
  try {
    const syntax = 'syntaxByResource' in discovered ? discovered.syntaxByResource.get(initial) : undefined
    accountCapability = syntax === undefined
      ? discoverNativeAccountCapability(initial)
      : discoverNativeAccountCapabilityFromSyntax(initial, syntax)
  } catch { /* Account admission reports its own unavailable capability. */ }
  const analysis: NativeSubmissionAnalysisCache = {
    schemaVersion: NATIVE_SUBMISSION_CACHE_SCHEMA,
    analyzerVersion: NATIVE_SUBMISSION_ANALYZER_VERSION,
    identity: analysisIdentity,
    transforms: captured,
    ...(accountCapability === undefined ? {} : { accountCapability }),
  }
  await writeAnalysisCache(cacheFile, analysis).catch(() => undefined)
  return {
    transforms: materializeCachedTransforms(captured),
    ...(accountCapability === undefined ? {} : { accountCapability }),
  }
}

export async function createNativeSubmissionComposition(
  activation: Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>,
  desktopExecutable: string,
  codexHome: string,
  options: Readonly<{ defaultProviderId?: string; cacheDirectory?: string }> = {},
): Promise<NativeSubmissionComposition> {
  const bootstrap = await prepareNativeSubmissionBootstrap(desktopExecutable, {
    ...(options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory }),
  })
  try {
    return await bootstrap.complete(activation, codexHome, options)
  } catch (error) {
    await bootstrap.close()
    throw error
  }
}

/** Start only the fail-closed native transport; compatibility discovery continues off the Host launch path. */
export async function prepareNativeSubmissionBootstrap(
  desktopExecutable: string,
  options: Readonly<{ cacheDirectory?: string }> = {},
): Promise<NativeSubmissionBootstrap> {
  if (process.platform !== 'darwin') throw new Error('Native managed routing requires a macOS app bundle')
  const executable = await realpath(desktopExecutable)
  const macos = path.dirname(executable)
  if (path.basename(macos) !== 'MacOS' || path.basename(path.dirname(macos)) !== 'Contents') {
    throw new Error('Native routing requires an app-bundle executable')
  }
  const contents = path.dirname(macos)
  const cli = await realpath(path.join(contents, 'Resources', 'codex'))
  await access(cli, constants.X_OK)
  await access(nativeAppServerIntermediaryPath(), constants.X_OK)
  let capabilities: ReturnType<typeof nativeSubmissionTransforms> | undefined
  const control = await startNativeSubmissionControlServer()
  let controller: NativeSubmissionController | undefined
  let credentials: ReturnType<typeof createNativeProviderCredentialBroker> | undefined
  let completion: Promise<NativeSubmissionComposition> | undefined
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> =>
    closePromise ??= (async () => {
      try {
        await controller?.dispose()
      } finally {
        try {
          await credentials?.close()
        } finally {
          await control.close()
        }
      }
    })()
  const environment = {
    CODEX_CLI_PATH: nativeAppServerIntermediaryPath(),
    CORDISX_NATIVE_CONTROL_SOCKET: control.socketPath,
    CORDISX_NATIVE_CONTROL_NONCE: control.nonce,
    CORDISX_NATIVE_REAL_CODEX_PATH: cli,
  }
  return {
    environment,
    complete(activation, codexHome, completeOptions = {}) {
      completion ??= (async () => {
        const discovered = await (capabilities ??= nativeSubmissionTransforms(
          contents,
          options.cacheDirectory ?? defaultNativeSubmissionCacheDirectory(),
        ))
        if (closePromise !== undefined) throw new Error('Native submission bootstrap was closed')
        credentials = createNativeProviderCredentialBroker({ resolve: id => activation.prepareNativeConnection(id) })
        let configured = await codexConfigModelProviders(codexHome)
        const managedIds = new Set(activation.nativeProviderIds)
        const configuredCatalog = async () => {
          configured = await codexConfigModelProviders(codexHome)
          return configured.providers
        }
        const cdp = createNativeSubmissionCdpAuthority({
          catalog: combinedNativeModelProviderCatalog(nativeModelProviderCatalog(activation), configuredCatalog),
          isThreadIdle: id => control.isThreadIdle(id),
          ...(completeOptions.defaultProviderId === undefined
            ? {}
            : { defaultProviderId: completeOptions.defaultProviderId }),
        })
        controller = createNativeSubmissionController({
          selection: cdp.selection,
          runtime: cdp.runtime,
          existingThread: control.existingThread,
          credentials: nativeSubmissionCredentialBroker({
            credentials,
            resolveEndpoint: id => activation.prepareNativeConnection(id),
          }),
          providerSource: providerId =>
            managedIds.has(providerId)
              ? 'managed'
              : configured.providerIds.has(providerId)
              ? 'config'
              : undefined,
        })
        control.bindController(controller)
        cdp.bindController(controller)
        return {
          installation: { authority: cdp, ...discovered },
          environment,
          close,
        }
      })()
      return completion
    },
    close,
  }
}
