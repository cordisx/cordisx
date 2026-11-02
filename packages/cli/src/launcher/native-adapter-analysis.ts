import type { NativeScriptResource } from './native-submission-structure.js'
import type { AdapterRuntime } from './codex-adapter/runtime.js'
import {
  discoverNativeAdapterAnalysis,
  materializeCachedTransforms,
  writeAnalysisCache,
} from './native-adapter-cache.js'
import { startNativeAdapterPreparation } from './native-adapter-preparation.js'
export { defaultNativeSubmissionCacheDirectory } from './native-adapter-cache.js'
export { NativeAdapterPreparationError, startNativeAdapterPreparation } from './native-adapter-preparation.js'
export type { NativeAdapterAnalysis, NativeAdapterPreparation } from './native-adapter-preparation.js'

/** Compatibility wrapper. New callers can start early and cancel via a preparation session. */
export async function nativeSubmissionTransforms(contents: string, cacheDirectory: string, adapterRoot: string) {
  const session = startNativeAdapterPreparation(contents, cacheDirectory, adapterRoot)
  return session.ready
}

/** In-process fixture/embedding path; production preparation performs this work in one Worker. */
export async function analyzeNativeAdapterResources(
  resources: readonly NativeScriptResource[],
  identity: { appVersion: string; buildNumber: string },
  cacheDirectory: string,
  runtime: AdapterRuntime,
) {
  const { analysis, cacheFile, cacheHit } = await discoverNativeAdapterAnalysis(
    resources,
    identity,
    cacheDirectory,
    runtime.identity,
    runtime.candidates,
  )
  const transforms = materializeCachedTransforms(analysis.transforms)
  const adapterLifecycle = await runtime.selected({
    transforms,
    modules: analysis.modules,
    rejected: analysis.rejected,
  })
  if (!cacheHit) await writeAnalysisCache(cacheFile, analysis).catch(() => undefined)
  return {
    transforms,
    adapterLifecycle,
    ...(analysis.accountCapability === undefined ? {} : { accountCapability: analysis.accountCapability }),
  }
}
