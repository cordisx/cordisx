import { parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { type AdapterBundle, bundle as builtin } from '@cordisx/codex-adapter'
import { readNativeSubmissionResources } from './native-app-resources.js'
import { discoverNativeAdapterAnalysis } from './native-adapter-cache.js'
import type { AdapterWorkerCandidate } from './codex-adapter/runtime.js'

export interface NativeAdapterWorkerInput {
  readonly generation: string
  readonly contents: string
  readonly identity: { appVersion: string; buildNumber: string }
  readonly adapterIdentity: string
  readonly cacheDirectory: string
  readonly candidates: readonly AdapterWorkerCandidate[]
}

/** Trusted code, not a sandbox. Original sources and ASTs stay exclusively in this Worker. */
async function analyze(input: NativeAdapterWorkerInput) {
  const rejected: Array<{ id: string; identity: string; reason: string }> = []
  const loaded = await Promise.all(input.candidates.map(async candidate => {
    try {
      let bundle = builtin
      if (candidate.entry) {
        const bytes = await readFile(candidate.entry)
        if (createHash('sha256').update(bytes).digest('hex') !== candidate.entryHash) {
          throw new Error('Adapter worker entry identity changed')
        }
        bundle = (await import(pathToFileURL(candidate.entry).href) as { bundle: AdapterBundle }).bundle
      }
      if (bundle?.version !== candidate.version || bundle.apiVersion !== 1 || bundle.relayContract !== 1) {
        throw new Error('Adapter worker bundle identity incompatible')
      }
      if (
        !Array.isArray(bundle.resourceHints)
        || !bundle.resourceHints.every(h =>
          Array.isArray(h) && h.length > 0 && h.every(s => typeof s === 'string' && s.length > 0)
        )
      ) throw new Error('Adapter discovery hints incompatible')
      return { identity: candidate.identity, bundle }
    } catch (error) {
      rejected.push({
        id: '*',
        identity: candidate.identity,
        reason: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }))
  const candidates = loaded.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
  const resources = readNativeSubmissionResources(input.contents, candidates.flatMap(c => c.bundle.resourceHints))
  const result = await discoverNativeAdapterAnalysis(
    resources,
    input.identity,
    input.cacheDirectory,
    input.adapterIdentity,
    candidates,
  )
  const message = {
    ...result,
    analysis: {
      ...result.analysis,
      rejected: [
        ...new Map([...result.analysis.rejected, ...rejected].map(record => [JSON.stringify(record), record])).values(),
      ],
    },
    generation: input.generation,
    adapterIdentity: input.adapterIdentity,
    metrics: {
      resourceCount: resources.length,
      resourceBytes: resources.reduce((sum, resource) => sum + Buffer.byteLength(resource.source), 0),
      resultBytes: 0,
    },
  }
  // Measure the actual serialized envelope, including metadata, without returning original resources or ASTs.
  for (;;) {
    const bytes = Buffer.byteLength(JSON.stringify({ result: message }))
    if (bytes === message.metrics.resultBytes) break
    message.metrics.resultBytes = bytes
  }
  return message
}
export type NativeAdapterWorkerResult = Awaited<ReturnType<typeof analyze>>

if (parentPort) {
  analyze(workerData as NativeAdapterWorkerInput).then(
    result => parentPort!.postMessage({ result }),
    error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  ).finally(() => parentPort!.close())
}
