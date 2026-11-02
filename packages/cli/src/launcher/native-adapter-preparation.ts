import { Worker } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import type { NativeAccountCapabilityDescriptor, NativeResourceTransform } from '@cordisx/codex-adapter'
import { type AdapterRuntime, type FrozenAdapterRuntime, openFrozenAdapterRuntime } from './codex-adapter/runtime.js'
import { checkPreparationSignal, NativeAdapterPreparationError } from './codex-adapter/preparation-error.js'
import { materializeCachedTransforms, writeAnalysisCache } from './native-adapter-cache.js'
import { acquireAdapterWorkerSlot } from './codex-adapter/worker-slot.js'
import type { NativeAdapterWorkerInput, NativeAdapterWorkerResult } from './native-adapter-worker.js'
export { NativeAdapterPreparationError } from './codex-adapter/preparation-error.js'

export interface NativeAdapterAnalysis {
  readonly transforms: readonly NativeResourceTransform[]
  readonly accountCapability?: NativeAccountCapabilityDescriptor
  readonly adapterLifecycle: Awaited<ReturnType<AdapterRuntime['selected']>>
  readonly metrics: {
    readonly resourceCount: number
    readonly resourceBytes: number
    readonly resultBytes: number
    readonly cacheHit: boolean
    readonly elapsedMs: number
  }
}
export interface NativeAdapterPreparation {
  readonly ready: Promise<NativeAdapterAnalysis>
  /** Cancels pending work, drains the Worker, and closes only this preparation's lease. Idempotent. */
  close(): Promise<void>
}

function startWorker(input: NativeAdapterWorkerInput, signal: AbortSignal): Promise<NativeAdapterWorkerResult> {
  checkPreparationSignal(signal)
  const compiled = new URL('./native-adapter-worker.js', import.meta.url)
  // Installed packages always use compiled JS. Source-mode uses the existing tsx loader,
  // rather than compiling another adapter or copying resource/AST graphs to the parent.
  const worker = existsSync(compiled)
    ? new Worker(compiled, { workerData: input, execArgv: [] })
    : new Worker(
      `const { tsImport } = require(${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm/api'))});`
        + `tsImport(${JSON.stringify(new URL('./native-adapter-worker.ts', import.meta.url).href)}, ${
          JSON.stringify(import.meta.url)
        });`,
      { eval: true, workerData: input, execArgv: [] },
    )
  return new Promise((resolve, reject) => {
    let result: NativeAdapterWorkerResult | undefined
    let failure: Error | undefined
    const abort = () => {
      void worker.terminate()
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.on('message', (message: { result?: NativeAdapterWorkerResult; error?: string }) => {
      if (signal.aborted) return
      if (result || failure) {
        failure = new NativeAdapterPreparationError('worker', 'Duplicate native adapter Worker result')
        void worker.terminate()
      } else if (message.error !== undefined) {
        failure = new NativeAdapterPreparationError('analysis', message.error)
      } else {
        result = message.result
      }
    })
    worker.once('error', error => {
      failure = new NativeAdapterPreparationError('worker', error.message, { cause: error })
    })
    // Never create a selected lease until all Worker code and late messages have drained.
    worker.once('exit', code => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(new NativeAdapterPreparationError('cancelled', 'Native adapter preparation cancelled'))
      else if (failure) reject(failure)
      else if (code !== 0 || !result) {
        reject(new NativeAdapterPreparationError('worker', `Native adapter Worker exited: ${code}`))
      } else resolve(result)
    })
    if (signal.aborted) abort()
  })
}

/** Starts once, owns at most one analysis Worker, and has an independent cancellation/lease lifetime. */
export function startNativeAdapterPreparation(
  contents: string,
  cacheDirectory: string,
  adapterRoot: string,
  options: { readonly signal?: AbortSignal } = {},
): NativeAdapterPreparation {
  const controller = new AbortController()
  const signal = controller.signal
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  let lifecycle: NativeAdapterAnalysis['adapterLifecycle'] | undefined
  const generation = randomUUID()
  const started = performance.now()
  const ready = (async (): Promise<NativeAdapterAnalysis> => {
    checkPreparationSignal(signal)
    let runtime: FrozenAdapterRuntime | undefined
    try {
      runtime = await openFrozenAdapterRuntime(adapterRoot, signal)
      checkPreparationSignal(signal)
      const info = path.join(contents, 'Info.plist')
      const execute = promisify(execFile)
      const [version, build] = await Promise.all([
        execute('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info], { signal }),
        execute('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', info], { signal }),
      ])
      checkPreparationSignal(signal)
      const releaseWorker = await acquireAdapterWorkerSlot(signal)
      let result: NativeAdapterWorkerResult
      try {
        result = await startWorker({
          contents,
          cacheDirectory,
          generation,
          adapterIdentity: runtime.identity,
          identity: { appVersion: version.stdout.trim(), buildNumber: build.stdout.trim() },
          candidates: runtime.workerCandidates,
        }, signal)
      } finally {
        releaseWorker()
      }
      checkPreparationSignal(signal)
      if (result.generation !== generation || result.adapterIdentity !== runtime.identity) {
        throw new NativeAdapterPreparationError('identity', 'Native adapter Worker generation or identity mismatch')
      }
      const transforms = materializeCachedTransforms(result.analysis.transforms)
      lifecycle = await runtime.selected({
        transforms,
        modules: result.analysis.modules,
        rejected: result.analysis.rejected,
      }, signal)
      checkPreparationSignal(signal)
      if (!result.cacheHit) {
        await writeAnalysisCache(path.join(cacheDirectory, `${result.analysis.identity}.json`), result.analysis, signal)
          .catch(error => {
            checkPreparationSignal(signal)
            void error
          })
      }
      checkPreparationSignal(signal)
      return {
        transforms,
        adapterLifecycle: lifecycle,
        ...(result.analysis.accountCapability === undefined
          ? {}
          : { accountCapability: result.analysis.accountCapability }),
        metrics: { ...result.metrics, cacheHit: result.cacheHit, elapsedMs: performance.now() - started },
      }
    } catch (error) {
      await lifecycle?.close()
      checkPreparationSignal(signal)
      if (error instanceof NativeAdapterPreparationError) throw error
      throw new NativeAdapterPreparationError('analysis', 'Native adapter preparation failed', { cause: error })
    } finally {
      await runtime?.close()
      options.signal?.removeEventListener('abort', abort)
    }
  })()
  // Starting early is safe even when the caller does not await until a later startup phase.
  void ready.catch(() => {})
  let closing: Promise<void> | undefined
  return {
    ready,
    close() {
      closing ??= (async () => {
        abort()
        await ready.catch(() => {})
        await lifecycle?.close()
        options.signal?.removeEventListener('abort', abort)
      })()
      return closing
    },
  }
}
