import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import type { RemoteTerminalProviderClient } from './remote-terminal-provider-client.js'

/** Local service owners precede the explicit remote service owner; native tables are projections, not ownership. */
export function nativeRemoteProviderSource(options: {
  readonly localSource: (id: string) => 'managed' | 'config' | undefined
  readonly localCatalog: () => Promise<readonly NativeModelProviderCatalogEntry[]>
  readonly validateLocal: (selection: { providerId: string; model: string }) => Promise<boolean>
  readonly remote?: RemoteTerminalProviderClient
}) {
  const source = (id: string) => {
    const local = options.localSource(id)
    if (local === 'managed') return local
    // The existing Host attests managed service IDs. A shared native table can
    // outlive its owner and must not shadow that Host's catalog or credentials.
    if (options.remote?.owns(id)) return 'remote'
    return local
  }
  return {
    source,
    catalog: async (): Promise<readonly NativeModelProviderCatalogEntry[]> => {
      const [local, remote] = await Promise.all([options.localCatalog(), options.remote?.catalog() ?? []])
      return Object.freeze([
        ...local.filter(provider => source(provider.providerId) !== 'remote'),
        ...remote.filter(provider => source(provider.providerId) === 'remote'),
      ])
    },
    validate: async (selection: { providerId: string; model: string }) =>
      source(selection.providerId) === 'remote'
        ? await options.remote!.validateSelection(selection)
        : await options.validateLocal(selection),
  }
}

/** Unknown non-native requests cannot borrow a persisted remote table before catalog installation. */
export function nativeRemoteUnmarkedGuard(options: {
  readonly localSource: (id: string) => 'managed' | 'config' | undefined
  readonly readThreadProvider: (threadId: string) => Promise<string | undefined>
}) {
  return async (input: { threadId?: string; providerId?: string }): Promise<boolean> => {
    const local = (id: string) => id === 'openai' || options.localSource(id) !== undefined
    if (input.providerId !== undefined && !local(input.providerId)) return false
    if (input.threadId === undefined) return input.providerId === undefined || local(input.providerId)
    const id = await options.readThreadProvider(input.threadId)
    return id !== undefined && local(id)
  }
}
