import { installSharedReactRuntime } from './react-runtime.js'
import {
  CordisXInternalRendererBootstrap,
  CordisXRuntimeHandle,
  CordisXRuntimeMetadata,
  RuntimeBrowserPlugin,
} from './runtime-shared.js'
import { start } from './runtime-start.js'

export function prepareCordisXViteReactRuntime(document: Document): () => void {
  const runtime = globalThis.__cordisxSharedReactRuntime ?? installSharedReactRuntime(document)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (globalThis.__cordisxSharedReactRuntime === runtime) runtime.dispose()
  }
}

function assertRequestedGeneration(metadata: CordisXRuntimeMetadata): void {
  if (
    metadata.generation !== undefined
    && globalThis.__cordisxRequestedGeneration !== metadata.generation
  ) {
    throw new Error('CordisX bootstrap generation was superseded')
  }
}

async function waitForRendererDocument(document: Document): Promise<void> {
  if (document.documentElement !== null && document.head !== null && document.body !== null) return
  await new Promise<void>(resolve => {
    let observer: MutationObserver | undefined
    const ready = (): void => {
      if (document.documentElement === null || document.head === null || document.body === null) return
      document.removeEventListener('readystatechange', ready)
      document.removeEventListener('DOMContentLoaded', ready)
      observer?.disconnect()
      resolve()
    }
    document.addEventListener('readystatechange', ready)
    document.addEventListener('DOMContentLoaded', ready)
    const Observer = document.defaultView?.MutationObserver
    if (Observer !== undefined) {
      observer = new Observer(ready)
      observer.observe(document, { childList: true, subtree: true })
    }
    queueMicrotask(ready)
  })
}

function serializeCordisXBoot(
  metadata: CordisXRuntimeMetadata,
  operation: () => Promise<CordisXRuntimeHandle>,
): Promise<CordisXRuntimeHandle> {
  if (
    metadata.generation !== undefined
    && globalThis.__cordisxBootGeneration === metadata.generation
    && globalThis.__cordisxBoot !== undefined
  ) return globalThis.__cordisxBoot
  globalThis.__cordisxRequestedGeneration = metadata.generation
  const previous = globalThis.__cordisxBoot ?? Promise.resolve(undefined)
  const next = previous.catch(() => undefined).then(async () => {
    // All scripts registered for this new document get one task to publish
    // their requested generation. A stale CDP registration therefore cannot
    // activate old plugin code before the newest registration supersedes it.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await waitForRendererDocument(document)
    assertRequestedGeneration(metadata)
    return await operation()
  })
  globalThis.__cordisxBootGeneration = metadata.generation
  globalThis.__cordisxBoot = next
  void next.catch(() => {
    if (globalThis.__cordisxBoot !== next) return
    globalThis.__cordisxBoot = undefined
    globalThis.__cordisxBootGeneration = undefined
    if (globalThis.__cordisxRequestedGeneration === metadata.generation) {
      globalThis.__cordisxRequestedGeneration = undefined
    }
  })
  return next
}

export function installCordisX(
  plugins: readonly RuntimeBrowserPlugin[],
  metadata: CordisXRuntimeMetadata,
  internalBootstrap?: CordisXInternalRendererBootstrap,
): Promise<CordisXRuntimeHandle> {
  return serializeCordisXBoot(
    metadata,
    async () => await start(plugins, metadata, internalBootstrap),
  )
}

export function installCordisXComposition(
  loadPlugins: () => Promise<readonly RuntimeBrowserPlugin[]>,
  metadata: CordisXRuntimeMetadata,
  publish: () => void,
  retire: () => void,
  internalBootstrap?: CordisXInternalRendererBootstrap,
): Promise<CordisXRuntimeHandle> {
  return serializeCordisXBoot(metadata, async () => {
    let disposeSharedReactRuntime: (() => void) | undefined
    let runtime: CordisXRuntimeHandle | undefined
    try {
      await globalThis.__cordisxRuntime?.dispose()
      const preparedSharedReactRuntimeDisposer = prepareCordisXViteReactRuntime(document)
      disposeSharedReactRuntime = preparedSharedReactRuntimeDisposer
      const plugins = await loadPlugins()
      assertRequestedGeneration(metadata)
      runtime = await start(plugins, metadata, internalBootstrap, {
        previousRuntimeDisposed: true,
        disposePreparedSharedReactRuntime: preparedSharedReactRuntimeDisposer,
      })
      publish()
      return runtime
    } catch (error) {
      try {
        retire()
      } catch (cleanupError) {
        console.error('[cordisx] failed to retire a failed composition graph', cleanupError)
      }
      if (runtime !== undefined) {
        await runtime.dispose().catch(cleanupError => {
          console.error('[cordisx] failed to dispose a failed composition runtime', cleanupError)
        })
        if (globalThis.__cordisxRuntime === runtime) globalThis.__cordisxRuntime = undefined
      }
      disposeSharedReactRuntime?.()
      throw error
    }
  })
}
