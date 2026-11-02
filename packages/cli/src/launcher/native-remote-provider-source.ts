import {
  combinedNativeModelProviderCatalog,
  type NativeModelProviderCatalogEntry,
} from './native-model-provider-catalog.js'
import type { RemoteTerminalProviderClient } from './remote-terminal-provider-client.js'

/** One precedence rule for display, validation, and execution; local ownership never changes on remote refresh. */
export function nativeRemoteProviderSource(options: {
  readonly localSource: (id: string) => 'managed' | 'config' | undefined
  readonly localCatalog: () => Promise<readonly NativeModelProviderCatalogEntry[]>
  readonly validateLocal: (selection: { providerId: string; model: string }) => Promise<boolean>
  readonly remote?: RemoteTerminalProviderClient
}) {
  const source = (id: string) => options.localSource(id) ?? (options.remote?.owns(id) ? 'remote' : undefined)
  return {
    source,
    catalog: combinedNativeModelProviderCatalog(options.localCatalog, async () => options.remote?.catalog() ?? []),
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
