import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { NativeResourceTransform, NativeScriptResource } from '@cordisx/codex-adapter'
import type { NativeAccountCapabilityDescriptor } from '../native-account-capability.js'
import { type AdapterCandidate, type AdapterSelection, selectAdapterModules } from './codex-adapter/selection.js'
import { TransformMaterializationSession } from './codex-adapter/materialization.js'
import { checkPreparationSignal } from './codex-adapter/preparation-error.js'
const NATIVE_SUBMISSION_CACHE_SCHEMA = 2
/** Bump whenever structural discovery or its generated transform contract changes. */
const NATIVE_SUBMISSION_ANALYZER_VERSION = 12
const SHA256 = /^[a-f0-9]{64}$/u

export interface CachedNativeTransform {
  readonly outputContract?: 'fixed-original-v1'
  readonly taskExecutionUrl?: string
  readonly url: string
  readonly sha256: string
  readonly source: string
  readonly sourceSha256: string
  readonly acknowledgementExpression: string
  readonly fenceExpression: string
  readonly requiredForDocumentReady: boolean
}

export interface NativeSubmissionAnalysisCache {
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

export function cacheIdentity(
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
  return transform.outputContract === 'fixed-original-v1'
    && resource !== undefined
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

export function materializeCachedTransforms(
  cached: readonly CachedNativeTransform[],
): readonly NativeResourceTransform[] {
  return cached.map(record =>
    Object.freeze({
      outputContract: 'fixed-original-v1' as const,
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

export async function readAnalysisCache(
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
      || !value.modules.every(module =>
        module && typeof module.id === 'string' && module.id.length > 0
        && typeof module.identity === 'string' && module.identity.length > 0
        && typeof module.version === 'string' && module.version.length > 0
      )
      || !value.modules.some(module => module.id === 'submission')
      || new Set(value.modules.map(module => module.id)).size !== value.modules.length
      || !value.rejected.every(record =>
        record && typeof record.id === 'string'
        && typeof record.identity === 'string' && typeof record.reason === 'string'
      )
      || !Array.isArray(value.transforms) || value.transforms.length === 0
      || !value.transforms.every(transform => validCachedTransform(transform, resources))
      || new Set(value.transforms.map(transform => transform.url)).size !== value.transforms.length
      || (value.accountCapability !== undefined && !validAccountCapability(value.accountCapability, resources))
    ) return undefined
    return value
  } catch {
    return undefined
  }
}

export async function writeAnalysisCache(
  file: string,
  value: NativeSubmissionAnalysisCache,
  signal?: AbortSignal,
): Promise<void> {
  checkPreparationSignal(signal)
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
    checkPreparationSignal(signal)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

function captureTransforms(
  transforms: readonly NativeResourceTransform[],
  resources: readonly NativeScriptResource[],
  session: TransformMaterializationSession,
): readonly CachedNativeTransform[] {
  return transforms.map(transform => {
    const resource = resources.find(candidate => candidate.url === transform.url)
    if (resource === undefined) throw new Error(`Native transform resource is unavailable: ${transform.url}`)
    const result = session.materialize(transform, resource.source)
    if (
      result.anchorMatches !== 1 || typeof result.source !== 'string'
      || typeof result.acknowledgementExpression !== 'string' || result.acknowledgementExpression.length === 0
      || typeof result.fenceExpression !== 'string' || result.fenceExpression.length === 0
    ) {
      throw new Error(`Native transform is not exact: ${transform.url}`)
    }
    return {
      ...(transform.outputContract === undefined ? {} : { outputContract: transform.outputContract }),
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

export async function discoverNativeAdapterAnalysis(
  resources: readonly NativeScriptResource[],
  identity: { appVersion: string; buildNumber: string },
  cacheDirectory: string,
  adapterIdentity: string,
  candidates: readonly AdapterCandidate[],
): Promise<{ analysis: NativeSubmissionAnalysisCache; cacheFile: string; cacheHit: boolean; cacheable: boolean }> {
  const analysisIdentity = cacheIdentity(identity.appVersion, identity.buildNumber, resources, adapterIdentity)
  const cacheFile = path.join(cacheDirectory, `${analysisIdentity}.json`)
  const cached = await readAnalysisCache(cacheFile, analysisIdentity, resources)
  if (
    cached
    && cached.modules.every(module =>
      candidates.some(candidate =>
        candidate.identity === module.identity && candidate.bundle.version === module.version
        && Array.isArray(candidate.bundle.modules) && candidate.bundle.modules.some(entry => entry.id === module.id)
      )
    )
  ) return { analysis: cached, cacheFile, cacheHit: true, cacheable: true }
  const session = new TransformMaterializationSession()
  const discovered = selectAdapterModules(candidates, { ...identity, resources }, session)
  const captured = captureTransforms(discovered.transforms, resources, session)
  return {
    cacheFile,
    cacheHit: false,
    cacheable: captured.every(transform => transform.outputContract === 'fixed-original-v1'),
    analysis: {
      schemaVersion: NATIVE_SUBMISSION_CACHE_SCHEMA,
      analyzerVersion: NATIVE_SUBMISSION_ANALYZER_VERSION,
      identity: analysisIdentity,
      transforms: captured,
      modules: discovered.modules,
      rejected: discovered.rejected,
      ...(discovered.accountCapability === undefined ? {} : { accountCapability: discovered.accountCapability }),
    },
  }
}
