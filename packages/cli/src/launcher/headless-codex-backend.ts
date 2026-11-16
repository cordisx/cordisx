import { type AgentBridgeCodexAuthority, createCodexBridgeHandler } from './agent-bridge.js'
import { type CodexAppServerRpc, startLocalCodexAppServer } from '../providers/codex-app-server.js'
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
  }, { environment: { ...input.environment ?? process.env, HOME: input.home } })
  try {
    if (!server.subscribeRequests) throw new Error('App-server request handling is unavailable')
    const unsubscribeRequests = server.subscribeRequests(input.onRequest)
    const unsubscribeNotifications = input.onNotification === undefined
      ? undefined
      : server.subscribeNotifications?.(input.onNotification)
    const authority: AgentBridgeCodexAuthority = {
      nativeRequest: (method: NativeBridgeMethod, params) =>
        input.nativeRequest?.(method, params, value => server.request(method, value))
          ?? server.request(method, params),
      catalog: async () => [],
    }
    const handler = createCodexBridgeHandler(authority, input.home)
    let closed: Promise<void> | undefined
    return {
      nativeRequest: authority.nativeRequest,
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
