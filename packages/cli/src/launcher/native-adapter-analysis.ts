import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { NativeResourceTransform } from './native-predispatch-interception.js'
import type { NativeScriptResource } from './native-submission-structure.js'
import type { NativeAccountCapabilityDescriptor } from '../native-account-capability.js'
import { readNativeSubmissionResources } from './native-app-resources.js'
import { type AdapterRuntime, openAdapterRuntime } from './codex-adapter/runtime.js'
import { type AdapterSelection, selectAdapterModules } from './codex-adapter/selection.js'
const execFileAsync = promisify(execFile)
const NATIVE_SUBMISSION_CACHE_SCHEMA = 2
/** Bump whenever structural discovery or its generated transform contract changes. */
const NATIVE_SUBMISSION_ANALYZER_VERSION = 10
const SHA256 = /^[a-f0-9]{64}$/u

interface CachedNativeTransform {
  readonly taskExecutionUrl?: string
  readonly url: string
  readonly sha256: string
  readonly source: string
  readonly sourceSha256: string
  readonly acknowledgementExpression: string
  readonly fenceExpression: string
  readonly requiredForDocumentReady: boolean
}

interface NativeSubmissionAnalysisCache {
  readonly schemaVersion: 2
  readonly analyzerVersion: number
  readonly identity: string
  readonly modules: AdapterSelection['modules']
  readonly rejected: AdapterSelection['rejected']
  readonly transforms: readonly CachedNativeTransform[]
  readonly accountCapability?: NativeAccountCapabilityDescriptor
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function defaultNativeSubmissionCacheDirectory(): string {
  return path.join(os.homedir(), 'Library', 'Caches', 'CordisX', 'native-submission')
}

function cacheIdentity(
  appVersion: string,
  buildNumber: string,
  resources: readonly NativeScriptResource[],
  adapterIdentity: string,
): string {
  return digest(JSON.stringify({
    adapterIdentity,
    analyzerVersion: NATIVE_SUBMISSION_ANALYZER_VERSION,
    appVersion,
    buildNumber,
    resources: resources.map(resource => ({ url: resource.url, sha256: digest(resource.source) })),
  }))
}

function validCachedTransform(
  value: unknown,
  resources: readonly NativeScriptResource[],
): value is CachedNativeTransform {
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
    && (transform.taskExecutionUrl === undefined
      || resources.some(resource => resource.url === transform.taskExecutionUrl))
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
    && (capability.readerProperty === undefined || capability.readerProperty === 'accessInputs'
      || capability.readerProperty === 'accountInfo')
}

function materializeCachedTransforms(
  cached: readonly CachedNativeTransform[],
): readonly NativeResourceTransform[] {
  return cached.map(record =>
    Object.freeze({
      url: record.url,
      sha256: record.sha256,
      requiredForDocumentReady: record.requiredForDocumentReady,
      ...(record.taskExecutionUrl === undefined ? {} : { taskExecutionUrl: record.taskExecutionUrl }),
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
    })
  )
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
      || !Array.isArray(value.modules) || !Array.isArray(value.rejected)
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
      ...(transform.taskExecutionUrl === undefined ? {} : { taskExecutionUrl: transform.taskExecutionUrl }),
    }
  })
}

export async function nativeSubmissionTransforms(
  contents: string,
  cacheDirectory: string,
  adapterRoot: string,
): Promise<{
  transforms: readonly NativeResourceTransform[]
  accountCapability?: NativeAccountCapabilityDescriptor
  adapterLifecycle: Awaited<ReturnType<AdapterRuntime['selected']>>
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
  const runtime = await openAdapterRuntime(adapterRoot)
  const hints = runtime.candidates.flatMap(c => c.bundle.resourceHints ?? [])
  const resources = readNativeSubmissionResources(contents, hints)
  return analyzeNativeAdapterResources(resources, identity, cacheDirectory, runtime)
}

export async function analyzeNativeAdapterResources(
  resources: readonly NativeScriptResource[],
  identity: { appVersion: string; buildNumber: string },
  cacheDirectory: string,
  runtime: AdapterRuntime,
) {
  const analysisIdentity = cacheIdentity(identity.appVersion, identity.buildNumber, resources, runtime.identity)
  const cacheFile = path.join(cacheDirectory, `${analysisIdentity}.json`)
  const cached = await readAnalysisCache(cacheFile, analysisIdentity, resources)
  if (cached !== undefined) {
    return {
      transforms: materializeCachedTransforms(cached.transforms),
      adapterLifecycle: await runtime.selected({
        transforms: materializeCachedTransforms(cached.transforms),
        modules: cached.modules,
        rejected: cached.rejected,
      }),
      ...(cached.accountCapability === undefined ? {} : { accountCapability: cached.accountCapability }),
    }
  }
  const discovered = selectAdapterModules(runtime.candidates, { ...identity, resources })
  const captured = captureTransforms(discovered.transforms, resources)
  const accountCapability = discovered.accountCapability
  const analysis: NativeSubmissionAnalysisCache = {
    schemaVersion: NATIVE_SUBMISSION_CACHE_SCHEMA,
    analyzerVersion: NATIVE_SUBMISSION_ANALYZER_VERSION,
    identity: analysisIdentity,
    transforms: captured,
    modules: discovered.modules,
    rejected: discovered.rejected,
    ...(accountCapability === undefined ? {} : { accountCapability }),
  }
  await writeAnalysisCache(cacheFile, analysis).catch(() => undefined)
  return {
    transforms: materializeCachedTransforms(captured),
    adapterLifecycle: await runtime.selected(discovered),
    ...(accountCapability === undefined ? {} : { accountCapability }),
  }
}
