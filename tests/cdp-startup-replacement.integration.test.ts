import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { type Context, createContext, runInContext } from 'node:vm'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { watchAndInject, type WatchInjectionOptions } from '../packages/cli/src/launcher/cdp.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import type { CdpSession, CdpTarget } from '../packages/cli/src/launcher/cdp-session.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import { createNativeSubmissionCdpAuthority } from '../packages/cli/src/launcher/native-submission-cdp-channel.js'

type Interruption = 'retired' | 'silent-retired' | 'unannounced-retired' | 'socket' | 'crashed' | 'activation'
const SOURCE = 'globalThis.__cordisxCompositionBoot = Promise.resolve(globalThis.__cordisxRuntime = { ready: true })'
const RESOURCE = 'globalThis.nativeReady = "ANCHOR";globalThis.__cordisxNativeContinuationLocalSendReady = true'

/** Real loopback CDP and the executable production bootstrap; no synthetic ready response. */
async function fixture(options: {
  interruption?: Interruption
  transforms?: boolean
  deniedRestore?: boolean
  heldSeed?: boolean
  replacements?: number
  initialWorkspaceVisible?: boolean
  launcherOwned?: boolean
  lifecycle?: WatchInjectionOptions['pluginLifecycle']
  browserUnavailable?: boolean
} = {}) {
  const calls: string[] = []
  const scopes = new Map<string, { socket: WebSocket; context: Context; scripts: Map<string, string> }>()
  let port = 0
  let generation = 0
  let initialWorkspaceVisible = options.initialWorkspaceVisible ?? true
  let replacementVisible = true
  let replacementBootAllowed = true
  let interrupted = false
  const target = (id: string, document = 'index.html'): CdpTarget => ({
    id,
    title: 'Codex',
    type: 'page',
    url: `app://-/${document}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${id}`,
  })
  const workspace = () => target(`workspace-${generation}`)
  const liveWorkspaces = () =>
    options.interruption === 'socket' && interrupted
      ? [target('workspace-0'), workspace()]
      : [workspace()]
  let seedActivated = !options.heldSeed
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/json/version') {
      response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/browser` }))
      return
    }
    response.end(JSON.stringify([
      target('helper', 'detached-window.html'),
      ...((generation === 0 ? initialWorkspaceVisible : replacementVisible)
        ? liveWorkspaces().map(current => ({
          ...current,
          url: seedActivated ? current.url : 'data:text/html;charset=utf-8,loading',
        }))
        : []),
    ]))
  })
  const sockets = new WebSocketServer({ server })
  const context = () =>
    createContext({
      document: { readyState: 'complete' },
      location: { href: 'app://-/index.html' },
      crypto,
      setTimeout,
      clearTimeout,
    })
  const shouldInterrupt = (id: string) => {
    const number = Number(id.split('-').at(-1))
    return number < (options.replacements ?? 1)
  }
  const interrupt = (id: string) => {
    interrupted = true
    const scope = scopes.get(id)!
    const interruption = options.interruption ?? 'retired'
    if (interruption === 'retired' || interruption === 'activation') {
      scope.socket.send(JSON.stringify({ method: 'Inspector.detached', params: { reason: 'target_closed' } }))
    } else if (interruption === 'crashed') {
      scope.socket.send(JSON.stringify({ method: 'Inspector.targetCrashed', params: {} }))
    }
    generation++
    seedActivated = true
    if (interruption === 'silent-retired' || interruption === 'crashed') {
      scopes.get('browser')?.socket.send(JSON.stringify({
        method: interruption === 'crashed' ? 'Target.targetCrashed' : 'Target.targetDestroyed',
        params: { targetId: id },
      }))
    }
    if (interruption === 'socket' || interruption === 'crashed') scope.socket.terminate()
    else scope.socket.close()
  }
  const load = (id: string) => {
    const scope = scopes.get(id)!
    scope.context = context()
    for (const source of scope.scripts.values()) runInContext(source, scope.context)
    if (options.transforms) {
      scope.socket.send(JSON.stringify({
        method: 'Fetch.requestPaused',
        params: {
          requestId: 'resource',
          request: { url: 'app://-/assets/pinned.js' },
          resourceType: 'Script',
          responseStatusCode: 200,
        },
      }))
    }
  }
  sockets.on('connection', (socket, request) => {
    const id = request.url!.slice(1)
    calls.push(`connect:${id}`)
    scopes.set(id, { socket, context: context(), scripts: new Map() })
    socket.on('message', async data => {
      const item = JSON.parse(String(data)) as { id: number; method: string; params: Record<string, unknown> }
      const params = item.params ?? {}
      calls.push(`${id}:${item.method}${item.method === 'Browser.setPermission' ? `:${params.setting}` : ''}`)
      const scope = scopes.get(id)!
      let result: unknown = {}
      let error: unknown
      try {
        if (item.method === 'Target.setDiscoverTargets' && options.browserUnavailable) {
          throw new Error('fixture browser observer unavailable')
        }
        if (item.method === 'Target.getTargets') {
          result = {
            targetInfos: [...liveWorkspaces().map(current => ({ targetId: current.id, type: 'page' })), {
              targetId: 'helper',
              type: 'page',
            }],
          }
        }
        if (item.method === 'Browser.setPermission' && params.setting === 'prompt' && options.deniedRestore) {
          throw new Error('fixture permission restore denied')
        }
        if (item.method === 'Page.addScriptToEvaluateOnNewDocument') {
          const identifier = `script-${scope.scripts.size}`
          scope.scripts.set(identifier, String(params.source))
          result = { identifier }
        } else if (item.method === 'Page.removeScriptToEvaluateOnNewDocument') {
          scope.scripts.delete(String(params.identifier))
        } else if (item.method === 'Fetch.getResponseBody') {
          result = { body: Buffer.from(RESOURCE).toString('base64'), base64Encoded: true }
        } else if (item.method === 'Fetch.fulfillRequest') {
          if (shouldInterrupt(id)) {
            interrupt(id)
            return
          }
          runInContext(Buffer.from(String(params.body), 'base64').toString(), scope.context)
        } else if (item.method === 'Runtime.evaluate') {
          const expression = String(params.expression)
          if (expression.includes('cordisx:production-boot-pending') && !options.transforms && shouldInterrupt(id)) {
            if (options.interruption === 'activation') {
              result = { result: { value: { ok: false, error: 'fixture plugin activation failed' } } }
              socket.send(JSON.stringify({ id: item.id, result }))
              interrupt(id)
            } else interrupt(id)
            return
          }
          if (expression.includes('cordisx:production-boot-pending') && !replacementBootAllowed) {
            result = { result: { value: { ok: false, error: 'cordisx:production-boot-pending' } } }
          } else result = { result: { value: await runInContext(expression, scope.context) } }
        }
      } catch (failure) {
        error = { code: -32000, message: failure instanceof Error ? failure.message : String(failure) }
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: item.id, result, error }))
      if (item.method === 'Page.reload') load(id)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as { port: number }).port
  const unsubscribe = vi.fn(() => calls.push('management-unsubscribe'))
  const management = {
    token: 'fixture-management',
    profileId: 'fixture',
    generation: 'fixture-generation',
    service: { subscribe: () => unsubscribe } as unknown as PluginManagementService,
  }
  const nativeDispose = vi.fn()
  const nativeAuthority = createNativeSubmissionCdpAuthority({
    catalog: async () => [],
    isThreadIdle: async () => true,
    submissionAvailable: false,
  })
  const nativeSubmission = options.transforms
    ? {
      authority: {
        install: async (session: CdpSession, current: CdpTarget) => {
          const channel = await nativeAuthority.install(session, current)
          return {
            dispose: async () => {
              calls.push(`native-dispose:${current.id}`)
              nativeDispose(current.id)
              await channel.dispose()
            },
          }
        },
      } as never,
      transforms: [{
        url: 'app://-/assets/pinned.js',
        sha256: createHash('sha256').update(RESOURCE).digest('hex'),
        transform: (source: string) => ({
          source: source.replace('ANCHOR', 'PATCHED'),
          anchorMatches: 1,
          acknowledgementExpression: 'globalThis.nativeReady === "PATCHED"',
          fenceExpression: 'delete globalThis.nativeReady;delete globalThis.__cordisxNativeContinuationLocalSendReady',
        }),
      }],
    }
    : undefined
  const abort = new AbortController()
  let hostExited = false
  const ready = vi.fn()
  const statuses: string[] = []
  const settings = {
    port,
    source: SOURCE,
    signal: abort.signal,
    launcherOwnedNativeTarget: options.launcherOwned ?? true,
    ownedHostExited: () => hostExited,
    hasLoopbackGraph: true,
    pluginArtifactOrigin: 'http://127.0.0.1:47123',
    pluginManagement: management,
    ...(options.lifecycle === undefined ? {} : { pluginLifecycle: options.lifecycle }),
    ...(nativeSubmission === undefined ? {} : { nativeSubmission }),
    ...(options.heldSeed
      ? {
        startupNavigation: Promise.resolve({
          target: workspace(),
          activate: async () => {
            seedActivated = true
            load('workspace-0')
          },
        }),
      }
      : {}),
    onReady: ready,
    onStatus: (line: string) => statuses.push(line),
  }
  let watching: Promise<{ error?: unknown }> | undefined
  return {
    calls,
    nativeDispose,
    unsubscribe,
    ready,
    statuses,
    interrupted: () => interrupted,
    scopes,
    showInitialWorkspace: () => initialWorkspaceVisible = true,
    markHostExited: () => hostExited = true,
    abort: () => abort.abort(),
    showReplacement: (value: boolean) => replacementVisible = value,
    allowBoot: (value: boolean) => replacementBootAllowed = value,
    start: () => watching = watchAndInject(settings).then(() => ({}), error => ({ error })),
    stop: async () => {
      abort.abort()
      await watching
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve())))
    },
  }
}

describe('first owned workspace during production installation', () => {
  it('waits through a helper-only target list and admits only the native workspace', async () => {
    const app = await fixture({ initialWorkspaceVisible: false, replacements: 0 })
    try {
      app.start()
      await vi.waitFor(() => expect(app.statuses).toContain('initial-native-workspace-wait'))
      expect(app.calls).toEqual([])
      expect(app.ready).not.toHaveBeenCalled()
      app.showInitialWorkspace()
      await vi.waitFor(() => expect(app.ready).toHaveBeenCalledOnce(), { timeout: 3_000 })
      expect(app.calls).toContain('connect:workspace-0')
      expect(app.calls).not.toContain('connect:helper')
    } finally {
      await app.stop()
    }
  })

  it('fails at the original deadline when the workspace never appears', async () => {
    const app = await fixture({ initialWorkspaceVisible: false })
    const now = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(now)
    try {
      const watching = app.start()
      await vi.waitFor(() => expect(app.statuses).toContain('initial-native-workspace-wait'))
      clock.mockImplementation(() => now() + 600_001)
      expect(String((await watching).error)).toContain(
        'Owned native workspace did not appear before the renderer installation deadline',
      )
      expect(app.calls).toEqual([])
      expect(app.ready).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
      await app.stop()
    }
  })

  it('fails when the owned Host exits while only a helper is visible', async () => {
    const app = await fixture({ initialWorkspaceVisible: false })
    try {
      const watching = app.start()
      await vi.waitFor(() => expect(app.statuses).toContain('initial-native-workspace-wait'))
      app.markHostExited()
      expect(String((await watching).error)).toContain('Owned Host exited before its native workspace was available')
      expect(app.calls).toEqual([])
      expect(app.ready).not.toHaveBeenCalled()
    } finally {
      await app.stop()
    }
  })

  it('aborts during the wait without connecting to the helper', async () => {
    const app = await fixture({ initialWorkspaceVisible: false })
    try {
      const watching = app.start()
      await vi.waitFor(() => expect(app.statuses).toContain('initial-native-workspace-wait'))
      app.abort()
      expect(await watching).toEqual({})
      expect(app.calls).toEqual([])
      expect(app.ready).not.toHaveBeenCalled()
    } finally {
      await app.stop()
    }
  })

  it('still rejects a production graph for a Host the watcher does not own', async () => {
    const app = await fixture({ initialWorkspaceVisible: false, launcherOwned: false })
    try {
      expect(String((await app.start()).error)).toContain(
        'production loopback graph compatibility requires a launcher-owned native target',
      )
      expect(app.statuses).not.toContain('initial-native-workspace-wait')
      expect(app.calls).toEqual([])
    } finally {
      await app.stop()
    }
  })
})

describe('owned workspace replacement during production installation', () => {
  it('keeps continuation active after successful replacement when the startup deadline expires', async () => {
    const app = await fixture({ transforms: true })
    const deadline = new AbortController()
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const timeouts: number[] = []
    const replacementTimeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      if (milliseconds === 2_000) return timeout(milliseconds)
      timeouts.push(milliseconds)
      return deadline.signal
    })
    try {
      app.start()
      await vi.waitFor(() => expect(app.ready).toHaveBeenCalledOnce(), { timeout: 3_000 })
      expect(timeouts).toHaveLength(1)
      const replacement = app.scopes.get('workspace-1')!.context
      expect(replacement.__cordisxNativeContinuationLocalSendReady).toBe(true)
      deadline.abort()
      // Let the actual CDP fence round trip settle if the deadline still owns the installed document.
      await delay(100)
      expect(replacement.__cordisxNativeContinuationLocalSendReady).toBe(true)
      expect(app.calls).not.toContain('workspace-1:Fetch.disable')
    } finally {
      replacementTimeout.mockRestore()
      await app.stop()
    }
    expect(app.scopes.get('workspace-1')?.context.__cordisxNativeContinuationLocalSendReady).toBeUndefined()
    expect(app.calls).toContain('workspace-1:Fetch.disable')
  })

  it.each([false, true])(
    'releases an interrupted native transform installation before admitting its replacement (held seed %s)',
    async heldSeed => {
      const app = await fixture({ transforms: true, heldSeed })
      app.allowBoot(false)
      try {
        app.start()
        await vi.waitFor(() => expect(app.interrupted()).toBe(true))
        await vi.waitFor(() => expect(app.calls).toContain('connect:workspace-1'))
        expect(app.ready).not.toHaveBeenCalled()
        expect(app.calls).not.toContain('connect:helper')
        expect(app.unsubscribe).toHaveBeenCalledTimes(1)
        expect(app.nativeDispose).toHaveBeenCalledWith('workspace-0')
        expect(app.calls.indexOf('browser:Browser.setPermission:prompt')).toBeLessThan(
          app.calls.indexOf('connect:workspace-1'),
        )
        expect(app.calls.indexOf('native-dispose:workspace-0')).toBeLessThan(app.calls.indexOf('connect:workspace-1'))
        app.allowBoot(true)
        await vi.waitFor(() => expect(app.ready).toHaveBeenCalledOnce(), { timeout: 3_000 })
        expect(app.scopes.get('workspace-1')?.context.__cordisxRuntime).toMatchObject({ ready: true })
        expect(app.scopes.get('workspace-1')?.context.nativeReady).toBe('PATCHED')
      } finally {
        await app.stop()
      }
      expect(app.unsubscribe.mock.calls.length).toBe(
        app.calls.filter(call => call.startsWith('connect:workspace-') || call === 'connect:helper').length,
      )
    },
  )

  it('waits for a workspace replacement without letting an earlier helper satisfy readiness', async () => {
    const app = await fixture()
    app.showReplacement(false)
    try {
      app.start()
      await vi.waitFor(() => expect(app.interrupted()).toBe(true))
      await vi.waitFor(() => expect(app.calls).toContain('browser:Browser.setPermission:prompt'))
      expect(app.ready).not.toHaveBeenCalled()
      expect(app.calls).not.toContain('connect:helper')
      app.showReplacement(true)
      await vi.waitFor(() => expect(app.ready).toHaveBeenCalledOnce(), { timeout: 3_000 })
    } finally {
      await app.stop()
    }
  })

  it.each(['silent-retired', 'unannounced-retired'] as const)(
    'confirms %s through independent browser evidence before releasing the native document',
    async interruption => {
      const app = await fixture({ transforms: true, interruption })
      try {
        let failure: unknown
        app.start().then(result => failure = result.error)
        await vi.waitFor(() => {
          if (failure !== undefined) throw failure
          expect(app.ready).toHaveBeenCalledOnce()
        }, { timeout: 3_000 })
        expect(app.calls).toContain('connect:workspace-1')
        expect(app.calls).not.toContain('connect:helper')
        expect(app.calls.indexOf('native-dispose:workspace-0')).toBeLessThan(app.calls.indexOf('connect:workspace-1'))
        expect(app.calls.indexOf('browser:Browser.setPermission:prompt')).toBeLessThan(
          app.calls.indexOf('connect:workspace-1'),
        )
        expect(app.scopes.get('workspace-1')?.context.nativeReady).toBe('PATCHED')
      } finally {
        await app.stop()
      }
    },
  )

  it('keeps a silent close terminal when browser identity evidence is unavailable', async () => {
    const app = await fixture({ transforms: true, interruption: 'unannounced-retired', browserUnavailable: true })
    try {
      const result = await app.start()
      expect(result.error).toBeInstanceOf(AggregateError)
      expect(app.ready).not.toHaveBeenCalled()
      expect(app.calls).not.toContain('connect:workspace-1')
    } finally {
      await app.stop()
    }
  })

  it.each(['socket', 'crashed', 'activation'] as const)(
    'keeps %s installation failure terminal even if a replacement appears',
    async interruption => {
      const app = await fixture({ interruption })
      try {
        const result = await app.start()
        expect(result.error).toBeInstanceOf(AggregateError)
        expect(String(result.error)).toContain('renderer installation failed')
        expect(app.ready).not.toHaveBeenCalled()
        expect(app.calls).not.toContain('connect:workspace-1')
        expect(app.unsubscribe).toHaveBeenCalledOnce()
      } finally {
        await app.stop()
      }
    },
  )

  it('keeps failed browser permission restoration terminal after confirmed target retirement', async () => {
    const app = await fixture({ deniedRestore: true })
    try {
      const result = await app.start()
      expect(result.error).toBeInstanceOf(AggregateError)
      expect(String(result.error)).toContain('cleanup was incomplete')
      expect(app.calls).toContain('browser:Browser.setPermission:prompt')
      expect(app.calls).not.toContain('connect:workspace-1')
      expect(app.ready).not.toHaveBeenCalled()
    } finally {
      await app.stop()
    }
  })

  it('bounds repeated native workspace retirement without accepting a helper', async () => {
    const app = await fixture({ replacements: 4 })
    try {
      const result = await app.start()
      expect(result.error).toBeInstanceOf(AggregateError)
      expect(app.calls).not.toContain('connect:workspace-4')
      expect(app.calls).not.toContain('connect:helper')
      expect(app.ready).not.toHaveBeenCalled()
    } finally {
      await app.stop()
    }
  })

  it('uses the original installation deadline while waiting for a replacement', async () => {
    const app = await fixture()
    app.showReplacement(false)
    const now = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + (app.interrupted() ? 60_001 : 0))
    try {
      const result = await app.start()
      expect(String(result.error)).toContain('renderer installation failed')
      expect(app.ready).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
      await app.stop()
    }
  })

  it('expires the original replacement deadline during recovery after its bootstrap has completed', async () => {
    let releaseRecovery!: () => void
    const recovery = new Promise<void>(resolve => releaseRecovery = resolve)
    let recoveryStarted = false
    const runtime = new CdpPluginLifecycleRuntime()
    const recoveredProjection = vi.spyOn(runtime, 'synchronizeRecoveredActivation')
    const statusProjection = vi.spyOn(runtime, 'synchronizeDevelopmentStatus')
    const lifecycle = {
      runtime,
      handler: {
        token: 'fixture-lifecycle',
        profileId: 'fixture',
        generation: 'fixture-generation',
        coordinator: {
          recover: async () => {
            recoveryStarted = true
            await recovery
          },
        } as never,
      },
    }
    const app = await fixture({ lifecycle })
    const deadline = new AbortController()
    const timeouts: number[] = []
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    // Keep target discovery's real timeout; manually expire the actual signal
    // the production watcher creates for the replacement's remaining deadline.
    const replacementTimeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      if (milliseconds === 2_000) return timeout(milliseconds)
      timeouts.push(milliseconds)
      return deadline.signal
    })
    try {
      const watching = app.start()
      await vi.waitFor(() => expect(recoveryStarted).toBe(true), { timeout: 3_000 })
      expect(app.scopes.get('workspace-1')?.context.__cordisxRuntime).toMatchObject({ ready: true })
      expect(timeouts).toHaveLength(1)
      expect(timeouts[0]).toBeGreaterThan(0)
      expect(timeouts[0]).toBeLessThan(60_000)
      expect(app.ready).not.toHaveBeenCalled()
      deadline.abort()
      const result = await watching
      expect(String(result.error)).toContain('renderer installation failed')
      expect(app.ready).not.toHaveBeenCalled()
      expect(app.unsubscribe).toHaveBeenCalledTimes(2)
      expect(app.calls.filter(call => call.endsWith(':Browser.setPermission:prompt'))).toHaveLength(2)
      expect(app.calls).toContain('workspace-1:Page.removeScriptToEvaluateOnNewDocument')
      // Cancellation releases the reservation before durable recovery finishes.
      const replacementJoin = runtime.beginJoin({} as CdpSession)
      replacementJoin.abort()
      releaseRecovery()
      await nextTurn()
      expect(recoveredProjection).not.toHaveBeenCalled()
      expect(statusProjection).not.toHaveBeenCalled()
      expect(app.ready).not.toHaveBeenCalled()
    } finally {
      replacementTimeout.mockRestore()
      releaseRecovery()
      recoveredProjection.mockRestore()
      statusProjection.mockRestore()
      await app.stop()
    }
  })
})
