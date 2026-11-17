import { type AgentBridgeCodexAuthority, createCodexBridgeHandler } from './agent-bridge.js'
import { type CodexAppServerRpc, startLocalCodexAppServer } from '../providers/codex-app-server.js'
import { parseModelReasoningCapabilities } from '../model-reasoning-capabilities.js'
import { channelNativeIdle } from './channel-native-idle.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

/** A launch-owned CLI app-server; it never attaches to a Desktop process. */
export async function startHeadlessCodexBackend(input: {
  readonly codexExecutable: string
  readonly codexHome: string
  readonly home: string
  readonly timeoutMs?: number
  readonly environment?: NodeJS.ProcessEnv
  /** The launch's existing approval authority owns responses to native requests. */
  readonly onRequest: (method: string, params: unknown, id?: string | number) => unknown | Promise<unknown>
  readonly onNotification?: (method: string, params: unknown) => void
  readonly onDispatch?: (operationId: string, threadId: string, turnId?: string) => void
  readonly nativeRequest?: (
    method: NativeBridgeMethod,
    params: Readonly<Record<string, unknown>>,
    next: (params: Readonly<Record<string, unknown>>) => Promise<unknown>,
  ) => Promise<unknown>
  readonly startServer?: typeof startLocalCodexAppServer
}) {
  const server = await (input.startServer ?? startLocalCodexAppServer)({
    id: 'headless-local',
    kind: 'local-codex',
    displayName: 'Local Codex',
    sourceProviderId: 'codex',
    codexExecutable: input.codexExecutable,
    codexHome: input.codexHome,
    enabled: true,
    timeoutMs: input.timeoutMs ?? 30_000,
  }, { environment: { ...input.environment ?? process.env, HOME: input.home }, experimentalApi: true })
  try {
    if (!server.subscribeRequests) throw new Error('App-server request handling is unavailable')
    const unsubscribeRequests = server.subscribeRequests(input.onRequest)
    const unsubscribeNotifications = input.onNotification === undefined
      ? undefined
      : server.subscribeNotifications?.(input.onNotification)
    const authority: AgentBridgeCodexAuthority = {
      ...(input.onDispatch ? { observedDispatch: input.onDispatch } : {}),
      nativeRequest: async (method: NativeBridgeMethod, params) => {
        let selected = params
        if (method === 'thread/start' && params.model == null && params.modelProvider == null) {
          const config = await server.request<{ config?: Record<string, unknown> }>('config/read', {
            includeLayers: false,
            ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
          })
          const native = config.config ?? {}
          if (native.model_provider == null || native.model_provider === 'openai') {
            const provider = (await models('list', {})).providers?.[0]
            if (typeof native.model === 'string' && !provider?.models.some(row => row.id === native.model)) {
              throw new Error('MODEL_NOT_IN_NATIVE_CATALOG')
            }
            if (native.model == null) {
              if (!provider?.defaultModelId) throw new Error('NATIVE_DEFAULT_MODEL_UNAVAILABLE')
              selected = { ...params, model: provider.defaultModelId }
            }
          }
        }
        return input.nativeRequest?.(method, selected, value => server.request(method, value))
          ?? server.request(method, selected)
      },
      catalog: async () => (await models('list', {})).providers ?? [],
    }
    const models = async (operation: string, value: unknown, beforeEffect?: () => Promise<boolean>) => {
      const rows: Record<string, unknown>[] = []
      let cursor: string | undefined
      const cursors = new Set<string>()
      let pages = 0
      do {
        if (++pages > 8) throw new Error('MODEL_CATALOG_PAGINATION_LIMIT')
        const page = await server.request<{ data: Record<string, unknown>[]; nextCursor?: string | null }>(
          'model/list',
          { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
        )
        if (!Array.isArray(page.data)) throw new Error('MODEL_CATALOG_UNAVAILABLE')
        rows.push(...page.data)
        cursor = page.nextCursor ?? undefined
        if (cursor && cursors.has(cursor)) throw new Error('MODEL_CATALOG_UNAVAILABLE')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      const visible = rows.filter(row =>
        row.hidden === false && typeof row.id === 'string'
        && typeof row.model === 'string' && row.model.length > 0
      )
      if (
        new Set(visible.map(row => row.model)).size !== visible.length
        || new Set(visible.map(row => row.id)).size !== visible.length
      ) throw new Error('MODEL_CATALOG_AMBIGUOUS')
      const catalog = visible.map(row => {
        const efforts = Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts.map(item =>
            item && typeof item === 'object'
              ? (item as Record<string, unknown>).reasoningEffort
              : undefined
          )
          : []
        const reasoningCapabilities = parseModelReasoningCapabilities({
          efforts,
          ...(typeof row.defaultReasoningEffort === 'string'
            ? { defaultEffort: row.defaultReasoningEffort }
            : {}),
        })
        return {
          id: row.model as string,
          label: typeof row.displayName === 'string' ? row.displayName : row.model as string,
          aliases: [] as string[],
          ...(reasoningCapabilities ? { reasoningCapabilities } : {}),
        }
      })
      if (operation === 'list') {
        const defaults = visible.filter(row => row.isDefault === true)
        return {
          providers: [{
            providerId: 'openai',
            pluginId: 'codex',
            models: catalog,
            ...(defaults.length === 1 ? { defaultModelId: defaults[0]!.model as string } : {}),
          }],
        }
      }
      const selection = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
      if (
        operation !== 'select' || selection.providerId !== 'openai'
        || typeof selection.threadId !== 'string' || typeof selection.model !== 'string'
        || !catalog.some(model => model.id === selection.model)
      ) {
        return { status: 'rejected', reason: 'selection-outside-catalog' }
      }
      let observed = await channelNativeIdle(authority, selection.threadId)
      if (!observed) return { status: 'rejected', reason: 'thread-not-idle' }
      if (beforeEffect && !await beforeEffect()) return { status: 'rejected', reason: 'selection-changed' }
      observed = await channelNativeIdle(authority, selection.threadId)
      if (!observed) return { status: 'rejected', reason: 'thread-not-idle' }
      const status = (observed.status as { type?: string } | undefined)?.type
      if (status !== 'notLoaded' && observed.modelProvider !== selection.providerId) {
        return { status: 'rejected', reason: 'provider-switch-unavailable' }
      }
      try {
        if (status !== 'notLoaded') {
          await authority.nativeRequest('thread/settings/update', {
            threadId: selection.threadId,
            model: selection.model,
          })
        }
        const resumed = await authority.nativeRequest('thread/resume', {
          threadId: selection.threadId,
          ...(status === 'notLoaded' ? { modelProvider: 'openai', model: selection.model } : {}),
        }) as { thread?: { id?: string }; model?: string; modelProvider?: string }
        if (
          resumed.thread?.id !== selection.threadId || resumed.model !== selection.model
          || resumed.modelProvider !== selection.providerId
        ) {
          return { status: 'reconciliation-required', reason: 'native-selection-unconfirmed' }
        }
        return { status: 'selected' }
      } catch {
        return { status: 'reconciliation-required', reason: 'native-selection-unavailable' }
      }
    }
    const handler = createCodexBridgeHandler(authority, input.home)
    let closed: Promise<void> | undefined
    return {
      nativeRequest: authority.nativeRequest,
      models,
      call: (app: string, operation: unknown, args: unknown) => {
        if (app !== 'codex') throw new Error('Unsupported backend')
        return handler(operation, args)
      },
      close: () => closed ??= closeServer(server, unsubscribeRequests, unsubscribeNotifications),
    }
  } catch (error) {
    await server.close().catch(() => undefined)
    throw error
  }
}

async function closeServer(server: CodexAppServerRpc, ...unsubscribe: (((() => void) | undefined))[]) {
  try {
    for (const dispose of unsubscribe) dispose?.()
  } finally {
    await server.close()
  }
}
