import type { ModuleNode, ViteDevServer } from 'vite'
import type {
  NativeVitePluginGeneration,
  NativeVitePluginGenerationHandler,
  NativeVitePluginGenerationTransaction,
} from './vite-development-generation.js'
import { VITE_CLIENT_DISPOSER_SOURCE } from './vite-development-graph.js'
import { NativeViteSourceMapStore } from './vite-development-source-maps.js'

interface ReloadPluginRequest {
  readonly pluginId?: unknown
  readonly requestId?: unknown
}

interface GenerationTransactionRequest extends ReloadPluginRequest {
  readonly action?: unknown
  readonly moduleGeneration?: unknown
  readonly transactionId?: unknown
}

export interface NativeViteGenerationTransactionRecord {
  readonly handle: NativeVitePluginGenerationTransaction
  readonly timeout: ReturnType<typeof setTimeout>
  readonly pluginId: string
  readonly moduleGeneration: string
}

export interface NativeViteServerAdapterContext<Generation extends { readonly moduleGeneration: string }> {
  readonly base: string
  readonly origin: string
  readonly bootUrl: string
  readonly sourceMaps: NativeViteSourceMapStore
  readonly generations: Map<string, Generation>
  readonly pendingGenerations: Map<string, Map<string, Generation>>
  readonly generationTransactions: Map<string, NativeViteGenerationTransactionRecord>
  readonly generationHandler: () => NativeVitePluginGenerationHandler | undefined
  readonly generationSnapshot: (pluginId: string, generation: Generation) => NativeVitePluginGeneration
  readonly owningPluginIds: (module: ModuleNode) => Promise<Set<string>>
  readonly invalidatePlugin: (pluginId: string, timestamp: number) => Promise<void>
}

export function nativeViteHotPayload(payload: unknown, timestamp = Date.now()): unknown {
  if (typeof payload !== 'object' || payload === null || !('type' in payload) || payload.type !== 'full-reload') {
    return payload
  }
  return { type: 'custom', event: 'cordisx:restart-host', data: { timestamp } }
}

/** Own the native Vite manifest, HMR protocol, generation transactions, and served source-map adapter. */
export function configureNativeViteServer<Generation extends { readonly moduleGeneration: string }>(
  vite: ViteDevServer,
  context: NativeViteServerAdapterContext<Generation>,
): void {
  vite.middlewares.use(`${context.base}host-manifest.json`, (_request, response) => {
    const body = JSON.stringify({ version: 1, entry: context.bootUrl })
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.setHeader('cache-control', 'no-store')
    response.end(body)
  })
  const hot = vite.environments.client!.hot
  hot.on?.('vite:invalidate', data => {
    void (async () => {
      const requestedPath = data.path.split('?')[0]
      const invalidated = await vite.moduleGraph.getModuleByUrl(data.path)
        ?? [...vite.moduleGraph.urlToModuleMap.entries()]
          .find(([moduleUrl]) => moduleUrl.split('?')[0] === requestedPath)?.[1]
      if (invalidated === undefined) return
      const timestamp = Date.now()
      for (const pluginId of await context.owningPluginIds(invalidated)) {
        await context.invalidatePlugin(pluginId, timestamp)
        hot.send({ type: 'custom', event: 'cordisx:replace-plugin', data: { pluginId, timestamp } })
      }
    })().catch(error =>
      vite.config.logger.error(
        `[cordisx] failed to replace invalidated plugin: ${error instanceof Error ? error.message : String(error)}`,
      )
    )
  })
  hot.on?.('cordisx:reload-plugin', (data: ReloadPluginRequest, client) => {
    const requestId = typeof data.requestId === 'string' ? data.requestId : ''
    const pluginId = typeof data.pluginId === 'string' ? data.pluginId : ''
    const timestamp = Date.now()
    void context.invalidatePlugin(pluginId, timestamp).then(() => {
      client.send({
        type: 'custom',
        event: 'cordisx:reload-plugin-result',
        data: { requestId, pluginId, timestamp },
      })
    }, error => {
      client.send({
        type: 'custom',
        event: 'cordisx:reload-plugin-result',
        data: { requestId, pluginId, timestamp, error: error instanceof Error ? error.message : String(error) },
      })
    })
  })
  hot.on?.('cordisx:plugin-generation-transaction', (data: GenerationTransactionRequest, client) => {
    const requestId = typeof data.requestId === 'string' ? data.requestId : ''
    const pluginId = typeof data.pluginId === 'string' ? data.pluginId : ''
    const moduleGeneration = typeof data.moduleGeneration === 'string' ? data.moduleGeneration : ''
    const transactionId = typeof data.transactionId === 'string' ? data.transactionId : ''
    const action = data.action
    const task = (async (): Promise<readonly unknown[] | undefined> => {
      if (action === 'stage') {
        // A different native window may already have committed this snapshot.
        // Keep the current generation stageable without accepting retired ones.
        const current = context.generations.get(pluginId)
        const generation = context.pendingGenerations.get(pluginId)?.get(moduleGeneration)
          ?? (current?.moduleGeneration === moduleGeneration ? current : undefined)
        if (generation === undefined) throw new Error('Unknown or stale Vite plugin generation')
        if (context.generationTransactions.has(transactionId)) {
          throw new Error('Vite plugin generation transaction already exists')
        }
        const handler = context.generationHandler()
        const transaction = handler === undefined
          ? { commit: async () => undefined, rollback: async () => undefined }
          : await handler(context.generationSnapshot(pluginId, generation))
        const timeout = setTimeout(() => {
          const staged = context.generationTransactions.get(transactionId)
          if (staged === undefined) return
          context.generationTransactions.delete(transactionId)
          void staged.handle.rollback().catch(error =>
            vite.config.logger.error(
              `[cordisx] failed to roll back abandoned plugin generation: ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          )
        }, 15_000)
        context.generationTransactions.set(transactionId, { handle: transaction, timeout, pluginId, moduleGeneration })
        return transaction.managedServiceUICapabilities
      }
      const transaction = context.generationTransactions.get(transactionId)
      if (transaction === undefined) throw new Error('Unknown Vite plugin generation transaction')
      if (transaction.pluginId !== pluginId || transaction.moduleGeneration !== moduleGeneration) {
        throw new Error('Vite plugin generation transaction scope mismatch')
      }
      if (action === 'commit') {
        await transaction.handle.commit()
        context.pendingGenerations.get(pluginId)?.delete(moduleGeneration)
      } else if (action === 'rollback') await transaction.handle.rollback()
      else throw new Error('Unknown Vite plugin generation transaction action')
      clearTimeout(transaction.timeout)
      context.generationTransactions.delete(transactionId)
      return undefined
    })()
    void task.then(managedServiceUICapabilities => {
      client.send({
        type: 'custom',
        event: 'cordisx:plugin-generation-transaction-result',
        data: {
          requestId,
          pluginId,
          moduleGeneration,
          transactionId,
          action,
          ...(managedServiceUICapabilities === undefined ? {} : { managedServiceUICapabilities }),
        },
      })
    }, error => {
      client.send({
        type: 'custom',
        event: 'cordisx:plugin-generation-transaction-result',
        data: {
          requestId,
          pluginId,
          moduleGeneration,
          transactionId,
          action,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    })
  })
  // Native pages must never receive Vite's window.location.reload fallback.
  const send = hot.send.bind(hot)
  hot.send = ((payload: unknown, data?: unknown) => {
    const normalized = nativeViteHotPayload(payload)
    if (typeof normalized === 'string') send(normalized, data)
    else send(normalized as Parameters<typeof send>[0])
  }) as typeof hot.send
  vite.middlewares.use((request, response, next) => {
    const pathname = new URL(request.url ?? '/', context.origin).pathname
    if (!pathname.startsWith(context.base)) {
      response.writeHead(404)
      response.end()
      return
    }
    const map = context.sourceMaps.get(pathname)
    if (map !== undefined) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      })
      response.end(map)
      return
    }
    const end = response.end.bind(response)
    response.end = ((chunk: unknown, ...args: unknown[]) => {
      if (
        (typeof chunk === 'string' || Buffer.isBuffer(chunk))
        && String(response.getHeader('content-type')).includes('javascript')
      ) {
        let source = String(chunk)
        if (pathname === context.base + '@vite/client') {
          const sourceMapIndex = source.lastIndexOf('\n//# sourceMappingURL=')
          source = sourceMapIndex < 0
            ? source + VITE_CLIENT_DISPOSER_SOURCE
            : source.slice(0, sourceMapIndex) + VITE_CLIENT_DISPOSER_SOURCE + source.slice(sourceMapIndex)
          chunk = source
          response.setHeader('content-length', Buffer.byteLength(source))
        }
        const match = /\n\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/
          .exec(source)
        if (match !== null) {
          const mapPath = context.sourceMaps.remember(context.base, match[1]!)
          chunk = source.slice(0, match.index)
            + (mapPath === undefined ? '\n' : '\n//# sourceMappingURL=' + context.origin + mapPath + '\n')
          response.setHeader('content-length', Buffer.byteLength(chunk as string))
        }
      }
      return Reflect.apply(end, response, [chunk, ...args])
    }) as typeof response.end
    next()
  })
}
