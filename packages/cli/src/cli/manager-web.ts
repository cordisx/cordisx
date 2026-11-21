import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { PluginManagementRpcOperation } from '../launcher/management-rpc.js'
import type { ManagerOwner } from './manager-owner.js'
import type { ManagerRendererGatewayProof } from './manager-renderer-gateway.js'
import type { ManagerRendererHandle } from './manager-renderer-sessions.js'
import { createManagerRendererGraphSession } from './manager-renderer-graph-session.js'
import { createManagerRendererBootstrap } from './manager-renderer-bootstrap.js'
import { MODEL_SERVICE_SAFE_WRITE_CONTRACT } from '../model-service-contracts.js'

const assets = new URL('../../assets/manager/', import.meta.url)
const files: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/manager.js': 'manager.js',
  '/manager-shell.js': 'manager-shell.js',
  '/manager-host.css': 'manager-host.css',
  '/manager-schema.js': 'manager-schema.js',
  '/manager-channel-ui.js': 'manager-channel-ui.js',
  '/manager.css': 'manager.css',
  '/manager-resource-worker.js': 'manager-resource-worker.js',
  '/manager-standalone.js': 'manager-standalone.js',
}
// Serve the same Host-owned styles used by the embedded Manager, never a copy.
const sharedStyles: Readonly<Record<string, URL>> = {
  '/shared/manager-navigation.css': new URL('../renderer/manager/manager-navigation.css', import.meta.url),
  '/shared/manager-content.css': new URL('../renderer/manager/manager-content.css', import.meta.url),
  '/shared/manager-browse.css': new URL('../renderer/manager/manager-browse.css', import.meta.url),
  '/shared/manager-catalog.css': new URL('../renderer/manager/manager-catalog.css', import.meta.url),
  '/shared/manager-compact-shell.css': new URL('../renderer/manager/manager-compact-shell.css', import.meta.url),
  '/shared/search.css': new URL('../renderer/host-ui/search.css', import.meta.url),
  '/shared/action-group.css': new URL('../renderer/host-ui/action-group.css', import.meta.url),
}
const mime: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
const managementKinds = new Set([
  'source-add',
  'source-edit',
  'source-set-enabled',
  'source-remove',
  'catalog-hide',
  'catalog-unhide',
  'plugin-plan-local',
  'plugin-plan-marketplace',
  'plugin-enable',
  'plugin-disable',
  'plugin-uninstall',
  'plugin-execute-plan',
])
const rendererChannelAllowlist = new Set(['plugin-management', 'managed-service-ui'])

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    length += chunk.length
    if (length > 1_048_576) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A browser-only adapter over the existing local owner; it has no profile authority of its own. */
export async function startManagerWeb(owner: ManagerOwner, options: {
  /** Private supervisor identity; it must never be supplied by the browser. */
  readonly rendererGateway?: ManagerRendererGatewayProof
} = {}) {
  const bootstraps = new Map<string, { deadline: number; timer: NodeJS.Timeout; retire?: () => Promise<void> }>()
  type BrowserSession = {
    id: string
    deadline: number
    timer: NodeJS.Timeout
    controller: AbortController
    managedServicesUsed: boolean
    channelCredentialsUsed: boolean
    rendererOpen?: Promise<ManagerRendererHandle | undefined>
    rendererCommands: boolean
    rendererChannels: readonly string[]
    graphs?: ReturnType<typeof createManagerRendererGraphSession>
    rendererBootstrap?: ReturnType<typeof createManagerRendererBootstrap>
    rendererBundle?: Promise<Awaited<ReturnType<ReturnType<typeof createManagerRendererBootstrap>['prepare']>>>
    resources?: Set<ServerResponse>
  }
  const sessions = new Map<string, BrowserSession>()
  const closedSessions = new Map<string, { deadline: number; retired: Promise<boolean> }>()
  let authority = ''
  const retire = async (key: string) => {
    const entry = bootstraps.get(key)
    if (!entry) return
    bootstraps.delete(key)
    clearTimeout(entry.timer)
    await entry.retire?.()
  }
  const issueUrl = (onRetire?: () => Promise<void>) => {
    if (bootstraps.size >= 16) throw new Error('MANAGER_LINK_LIMIT')
    const bootstrap = randomBytes(32).toString('hex')
    const timer = setTimeout(() => {
      void retire(bootstrap).catch(() => undefined)
    }, 60_000)
    timer.unref()
    bootstraps.set(bootstrap, { deadline: Date.now() + 60_000, timer, ...(onRetire ? { retire: onRetire } : {}) })
    return `http://${authority}/#${bootstrap}`
  }
  const revokeUrl = async (url: string) => {
    await retire(new URL(url).hash.slice(1))
  }
  const retireSession = async (token: string) => {
    const session = sessions.get(token)
    if (!session) return await closedSessions.get(token)?.retired ?? false
    sessions.delete(token)
    clearTimeout(session.timer)
    session.controller.abort()
    session.graphs?.close()
    for (const response of session.resources ?? []) response.destroy()
    void session.rendererBundle?.then(result => result.bundle.fill(0)).catch(() => undefined)
    const retireKinds = [
      ...(session.managedServicesUsed ? ['manager-service-auth'] : []),
      ...(session.channelCredentialsUsed ? ['manager-channel-credentials'] : []),
    ]
    const retireOperations = retireKinds.map(kind => {
      const operation = { kind, action: 'retire', sessionId: session.id }
      return owner.request(operation as unknown as PluginManagementRpcOperation, { timeoutMs: 1_000 })
        .then(result => object(result)?.status === 'retired')
    })
    // Revoke even if opening is still in flight: the owner tombstones the
    // browser session before admitting a late result.
    if (session.rendererOpen !== undefined && options.rendererGateway !== undefined) {
      retireOperations.push(
        owner.request({
          kind: 'manager-renderer',
          action: 'revoke',
          gateway: options.rendererGateway,
          browserSessionId: session.id,
        }, { timeoutMs: 1_000 }).then(result => object(result)?.status === 'ok'),
      )
    }
    const retired = Promise.allSettled(retireOperations).then(results =>
      results.every(result => result.status === 'fulfilled' && result.value)
    )
    closedSessions.set(token, { deadline: Date.now() + 60_000, retired })
    while (closedSessions.size > 128) closedSessions.delete(closedSessions.keys().next().value!)
    return await retired
  }
  const touchSession = (token: string, id: string, managedServicesUsed: boolean): BrowserSession => {
    const previous = sessions.get(token)
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => {
      void retireSession(token)
    }, 8 * 60 * 60_000)
    timer.unref()
    const session = previous ?? {
      id,
      deadline: 0,
      timer,
      controller: new AbortController(),
      managedServicesUsed,
      channelCredentialsUsed: false,
      rendererCommands: false,
      rendererChannels: [],
    }
    session.deadline = Date.now() + 8 * 60 * 60_000
    session.timer = timer
    sessions.set(token, session)
    return session
  }
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader(
      'content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    )
    if (request.headers.host !== authority) return json(response, 403, { error: 'INVALID_HOST' })
    const origin = request.headers.origin
    if (origin !== undefined && origin !== `http://${authority}`) {
      return json(response, 403, { error: 'INVALID_ORIGIN' })
    }
    const target = request.url ?? '/'
    if (target.length > 8192 || !target.startsWith('/') || target.startsWith('//')) {
      return json(response, 400, { error: 'INVALID_REQUEST' })
    }
    let url: URL
    try {
      url = new URL(target, `http://${authority}`)
      if (url.origin !== `http://${authority}`) return json(response, 400, { error: 'INVALID_REQUEST' })
    } catch {
      return json(response, 400, { error: 'INVALID_REQUEST' })
    }
    const file = url.pathname === '/' && url.search === '?host=1'
      ? 'manager-standalone.html'
      : files[url.pathname]
    const shared = sharedStyles[url.pathname]
    if (request.method === 'GET' && (file !== undefined || shared !== undefined)) {
      try {
        const contents = await readFile(shared ?? new URL(file!, assets)).catch(async error => {
          // Generated assets live in dist during source-mode development;
          // packaged execution resolves them from the normal assets directory.
          if (file !== 'manager-shell.js' && file !== 'manager-host.css' && file !== 'manager-standalone.js') {
            throw error
          }
          return await readFile(new URL(`../../dist/assets/manager/${file}`, import.meta.url))
        })
        const extension = url.pathname === '/' ? '.html' : url.pathname.slice(url.pathname.lastIndexOf('.'))
        response.writeHead(200, { 'content-type': mime[extension] ?? 'application/octet-stream' })
        response.end(contents)
      } catch {
        json(response, 503, { error: 'MANAGER_ASSETS_UNAVAILABLE' })
      }
      return
    }
    if (!url.pathname.startsWith('/api/')) return json(response, 404, { error: 'NOT_FOUND' })
    if (url.pathname === '/api/session') {
      if (
        request.method !== 'POST' || origin !== `http://${authority}`
        || !request.headers['content-type']?.startsWith('application/json')
      ) return json(response, 403, { error: 'INVALID_ORIGIN' })
      try {
        const offered = object(await body(request))
        const bootstrap = typeof offered?.token === 'string' ? offered.token : ''
        const entry = bootstraps.get(bootstrap)
        // Remove and retire before issuing a session, including for expired links.
        await retire(bootstrap)
        if (entry === undefined || entry.deadline <= Date.now()) {
          return json(response, 401, { error: 'UNAUTHORIZED' })
        }
        const token = randomBytes(32).toString('hex')
        for (const [key, session] of sessions) if (session.deadline <= Date.now()) await retireSession(key)
        while (sessions.size >= 16) await retireSession(sessions.keys().next().value!)
        touchSession(token, randomBytes(32).toString('hex'), false)
        return json(response, 200, { token })
      } catch {
        return json(response, 400, { error: 'INVALID_REQUEST' })
      }
    }
    const token = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : ''
    const previousSession = sessions.get(token)
    if (previousSession === undefined || previousSession.deadline <= Date.now()) {
      if (
        previousSession === undefined && request.method === 'POST' && url.pathname === '/api/renderer/close'
        && origin === `http://${authority}` && (closedSessions.get(token)?.deadline ?? 0) > Date.now()
        && request.headers['content-type']?.startsWith('application/json')
      ) {
        const input = object(await body(request).catch(() => undefined))
        if (input && Object.keys(input).length === 0) {
          return await retireSession(token)
            ? json(response, 200, { closed: true })
            : json(response, 503, { error: 'RENDERER_CLOSE_UNAVAILABLE' })
        }
      }
      await retireSession(token)
      return json(response, 401, { error: 'UNAUTHORIZED' })
    }
    const session = touchSession(token, previousSession.id, previousSession.managedServicesUsed)
    if (request.method === 'POST' && origin !== `http://${authority}`) {
      return json(response, 403, { error: 'INVALID_ORIGIN' })
    }
    const activeSession = () =>
      sessions.get(token) === session && session.deadline > Date.now()
      && !session.controller.signal.aborted
    let mutationDispatched = false
    const scopedRequest = async (operation: PluginManagementRpcOperation, mutation = false) => {
      if (!activeSession()) throw new Error('MANAGER_SESSION_REVOKED')
      if (mutation) mutationDispatched = true
      const result = await owner.request(operation, { signal: session.controller.signal })
      if (!activeSession()) throw new Error('MANAGER_SESSION_REVOKED')
      return result
    }
    const revoked = () =>
      json(response, mutationDispatched ? 503 : 401, {
        error: mutationDispatched ? 'OPERATION_RESULT_UNKNOWN' : 'UNAUTHORIZED',
      })
    const scopedReply = (value: unknown) => activeSession() ? json(response, 200, value) : revoked()
    try {
      if ((request.method === 'GET' || request.method === 'HEAD') && target === '/api/renderer/bundle.js') {
        if (!session.rendererBootstrap || !session.rendererBundle) return json(response, 404, { error: 'NOT_FOUND' })
        const built = await session.rendererBundle
        if (!activeSession() || !await session.rendererBootstrap.isSessionCurrent() || !activeSession()) {
          await retireSession(token)
          return json(response, 401, { error: 'UNAUTHORIZED' })
        }
        session.resources ??= new Set()
        session.resources.add(response)
        response.once('close', () => session.resources?.delete(response))
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': built.bundle.byteLength,
          'cache-control': 'private, no-store, max-age=0',
          'cross-origin-resource-policy': 'same-origin',
        })
        response.end(request.method === 'HEAD' ? undefined : built.bundle)
        return
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/api/renderer/graphs/')) {
        if (!session.graphs) return json(response, 404, { error: 'NOT_FOUND' })
        if (!activeSession() || !await owner.isCurrent().catch(() => false)) {
          await retireSession(token)
          return json(response, 401, { error: 'UNAUTHORIZED' })
        }
        const transfer = new AbortController()
        const abortOnClose = () => {
          if (!response.writableEnded) transfer.abort()
        }
        response.once('close', abortOnClose)
        const timer = setTimeout(() => transfer.abort(), 20_000)
        timer.unref()
        let result: Awaited<ReturnType<typeof session.graphs.resolve>>
        try {
          result = await session.graphs.resolve({
            method: request.method,
            target,
            signal: AbortSignal.any([session.controller.signal, transfer.signal]),
          })
        } finally {
          clearTimeout(timer)
          response.off('close', abortOnClose)
        }
        if (transfer.signal.aborted) return response.destroy()
        if (!activeSession() || !await owner.isCurrent().catch(() => false)) {
          await retireSession(token)
          return json(response, 401, { error: 'UNAUTHORIZED' })
        }
        response.writeHead(result.status, result.headers)
        response.end(request.method === 'HEAD' ? undefined : result.body)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const [management, services, rendererPlugins] = await Promise.allSettled([
          scopedRequest({ kind: 'query' }),
          scopedRequest({ kind: 'codex', operation: 'model-services:read', input: {} }),
          scopedRequest({ kind: 'plugin-configuration', action: 'list' } as unknown as PluginManagementRpcOperation),
        ])
        if (!activeSession()) return json(response, 401, { error: 'UNAUTHORIZED' })
        return json(response, 200, {
          owner: { appId: owner.appId, profileId: owner.profileId },
          management: management.status === 'fulfilled' ? management.value : { status: 'unavailable' },
          services: services.status === 'fulfilled' ? services.value : { status: 'unavailable' },
          rendererPlugins: rendererPlugins.status === 'fulfilled' ? rendererPlugins.value : { status: 'unavailable' },
        })
      }
      if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) {
        return json(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      }
      const input = object(await body(request))
      if (!activeSession()) return json(response, 401, { error: 'UNAUTHORIZED' })
      if (!input) return json(response, 400, { error: 'INVALID_REQUEST' })
      if (url.pathname === '/api/renderer/open') {
        if (Object.keys(input).length !== 0 || options.rendererGateway === undefined) {
          return json(response, 503, { error: 'RENDERER_UNAVAILABLE' })
        }
        const gateway = options.rendererGateway
        session.rendererOpen ??= (async () => {
          try {
            const result = object(
              await owner.request({
                kind: 'manager-renderer',
                action: 'open',
                gateway,
                browserSessionId: session.id,
              }, { signal: session.controller.signal }),
            )
            const handle = object(result?.handle)
            if (
              result?.status !== 'ok' || !handle
              || !Array.isArray(result.channels) || !result.channels.includes('plugin-management')
              || result.channels.length > rendererChannelAllowlist.size
              || new Set(result.channels).size !== result.channels.length
              || result.channels.some(channel => typeof channel !== 'string' || !rendererChannelAllowlist.has(channel))
              || result.commands !== undefined && typeof result.commands !== 'boolean'
              || typeof handle.rendererId !== 'string' || !/^[a-f0-9]{64}$/u.test(handle.rendererId)
              || typeof handle.grant !== 'string' || !/^[a-f0-9]{64}$/u.test(handle.grant)
              || handle.ownerGeneration !== owner.generation
            ) return undefined
            const privateHandle = {
              rendererId: handle.rendererId,
              grant: handle.grant,
              ownerGeneration: handle.ownerGeneration,
            }
            if (!activeSession()) {
              // The normal revocation is already in flight. If a transport
              // still delivers a late handle, retire that exact handle too.
              void owner.request({
                kind: 'manager-renderer',
                action: 'close',
                gateway,
                browserSessionId: session.id,
                handle: privateHandle,
              }, { timeoutMs: 1_000 }).catch(() => undefined)
              return undefined
            }
            session.rendererCommands = result.commands === true
            session.rendererChannels = [...result.channels] as string[]
            if (session.rendererCommands) {
              session.graphs = createManagerRendererGraphSession({
                managerOrigin: `http://${authority}`,
                profileId: owner.profileId,
                generation: owner.generation,
                rendererId: privateHandle.rendererId,
                isCurrent: activeSession,
                forbiddenSecrets: [token, gateway.instanceToken, privateHandle.grant],
              })
              session.rendererBootstrap = createManagerRendererBootstrap({
                owner,
                invocation: { gateway, browserSessionId: session.id, handle: privateHandle },
                managerOrigin: `http://${authority}`,
                projection: session.graphs,
                isCurrent: async () => activeSession() && await owner.isCurrent().catch(() => false) && activeSession(),
                signal: session.controller.signal,
                forbiddenSecrets: [token, gateway.instanceToken, privateHandle.grant],
              })
            }
            return privateHandle
          } catch {
            return undefined
          }
        })()
        const handle = await session.rendererOpen
        if (!activeSession()) return revoked()
        return handle === undefined
          ? json(response, 503, { error: 'RENDERER_UNAVAILABLE' })
          : json(response, 200, {
            status: 'ok',
            profileId: owner.profileId,
            channels: session.rendererChannels,
            // Public opaque identity is distinct from the private owner grant.
            ...(session.rendererCommands
              ? { commands: true, rendererId: handle.rendererId, generation: handle.ownerGeneration }
              : {}),
          })
      }
      if (['/api/renderer/session', '/api/renderer/bootstrap', '/api/renderer/close'].includes(url.pathname)) {
        if (Object.keys(input).length !== 0) return json(response, 400, { error: 'INVALID_REQUEST' })
        if (url.pathname === '/api/renderer/close') {
          return await retireSession(token)
            ? json(response, 200, { closed: true })
            : json(response, 503, { error: 'RENDERER_CLOSE_UNAVAILABLE' })
        }
        if (!session.rendererBootstrap || !session.rendererOpen) {
          return json(response, 503, { error: 'RENDERER_UNAVAILABLE' })
        }
        const handle = await session.rendererOpen
        if (!handle || !activeSession()) return revoked()
        if (url.pathname === '/api/renderer/session') {
          if (!await session.rendererBootstrap.isSessionCurrent() || !activeSession()) {
            await retireSession(token)
            return json(response, 401, { error: 'UNAUTHORIZED' })
          }
          return json(response, 200, {
            current: true,
            rendererId: handle.rendererId,
            generation: handle.ownerGeneration,
          })
        }
        session.rendererBundle ??= session.rendererBootstrap.prepare()
        try {
          const built = await session.rendererBundle
          if (!activeSession() || !await session.rendererBootstrap.isSessionCurrent() || !activeSession()) {
            throw new Error('renderer-session-unavailable')
          }
          return json(response, 200, {
            status: 'ok',
            bundleUrl: '/api/renderer/bundle.js',
            initialGraphs: built.initialGraphs,
          })
        } catch {
          await retireSession(token)
          return json(response, 503, { error: 'RENDERER_UNAVAILABLE' })
        }
      }
      if (['/api/renderer/admit', '/api/renderer/poll', '/api/renderer/acknowledge'].includes(url.pathname)) {
        if (!session.rendererCommands || session.rendererOpen === undefined || options.rendererGateway === undefined) {
          return json(response, 503, { error: 'RENDERER_COMMANDS_UNAVAILABLE' })
        }
        const action = url.pathname.slice('/api/renderer/'.length)
        if (
          action === 'admit' && Object.keys(input).length !== 0
          || action === 'poll' && (Object.keys(input).length !== 1
              || !Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1
              || Number(input.timeoutMs) > 30_000)
          || action === 'acknowledge' && (Object.keys(input).length !== 1
              || !Object.hasOwn(input, 'receipt') || Buffer.byteLength(JSON.stringify(input)) > 196 * 1024)
        ) return json(response, 400, { error: 'INVALID_REQUEST' })
        const handle = await session.rendererOpen
        if (!activeSession()) return revoked()
        if (handle === undefined) return json(response, 503, { error: 'RENDERER_UNAVAILABLE' })
        const common = {
          kind: 'manager-renderer' as const,
          gateway: options.rendererGateway,
          browserSessionId: session.id,
          handle,
        }
        const operation: PluginManagementRpcOperation = action === 'admit'
          ? { ...common, action: 'admit' }
          : action === 'poll'
          ? { ...common, action: 'poll', timeoutMs: Number(input.timeoutMs) }
          : { ...common, action: 'acknowledge', receipt: input.receipt }
        // Poll can hand out a command, and acknowledge can settle a mutation.
        // If either response is lost the caller must reconcile, not retry it.
        try {
          const result = object(await scopedRequest(operation, true))
          if (result?.status === 'unknown') {
            await retireSession(token)
            return json(response, 503, { error: 'OPERATION_RESULT_UNKNOWN' })
          }
          if (result?.status !== 'ok') return json(response, 503, { error: 'RENDERER_COMMANDS_UNAVAILABLE' })
          if (action === 'poll') {
            const value = object(result.value)
            if (!value || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'command')) {
              throw new Error('invalid')
            }
            return scopedReply({
              command: value.command === null ? null : session.graphs!.projectCommand(value.command),
            })
          }
          if (action === 'acknowledge') session.graphs!.acknowledge(input.receipt)
          return scopedReply(result.value)
        } catch {
          await retireSession(token)
          return json(response, 503, { error: 'OPERATION_RESULT_UNKNOWN' })
        }
      }
      if (url.pathname === '/api/renderer/binding') {
        if (
          Object.keys(input).length !== 2 || typeof input.channel !== 'string'
          || !session.rendererChannels.includes(input.channel) || typeof input.payload !== 'string'
          || Buffer.byteLength(JSON.stringify(input)) > 200 * 1024
          || session.rendererOpen === undefined || options.rendererGateway === undefined
        ) return json(response, 400, { error: 'RENDERER_BINDING_UNAVAILABLE' })
        const handle = await session.rendererOpen
        if (!activeSession()) return revoked()
        if (handle === undefined) return json(response, 503, { error: 'RENDERER_UNAVAILABLE' })
        // The owner applies its own strict channel parser and capability
        // checks. A browser cannot choose a handle, gateway, or session ID.
        const result = object(
          await scopedRequest({
            kind: 'manager-renderer',
            action: 'call',
            gateway: options.rendererGateway,
            browserSessionId: session.id,
            handle,
            channel: input.channel,
            payload: input.payload,
          }),
        )
        if (result?.status !== 'ok') return json(response, 503, { error: 'RENDERER_BINDING_UNAVAILABLE' })
        return scopedReply(result.value)
      }
      if (url.pathname === '/api/channel-credentials') {
        const bounded = (value: unknown, limit: number): value is string =>
          typeof value === 'string'
          && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value)
        const action = input.action
        let operation: Record<string, unknown> | undefined
        if (action === 'view' && Object.keys(input).every(key => key === 'action')) {
          operation = { kind: 'manager-channel-credentials', action, sessionId: session.id }
        } else if (action === 'capture') {
          const account = object(input.account)
          if (
            Object.keys(input).every(key =>
              ['action', 'purpose', 'expectedRevision', 'serviceGeneration', 'account', 'secret'].includes(key)
            )
            && (input.purpose === 'create' || input.purpose === 'rotate')
            && Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) >= 0
            && bounded(input.serviceGeneration, 512) && bounded(input.secret, 16_384) && account
            && Object.keys(account).every(key => ['adapterId', 'accountId', 'tenantId'].includes(key))
            && (account.adapterId === 'feishu' || account.adapterId === 'lark')
            && bounded(account.accountId, 512) && typeof account.tenantId === 'string'
            && (account.tenantId === '' || bounded(account.tenantId, 512))
          ) {
            operation = {
              kind: 'manager-channel-credentials',
              action,
              sessionId: session.id,
              purpose: input.purpose,
              expectedRevision: input.expectedRevision,
              serviceGeneration: input.serviceGeneration,
              account: { adapterId: account.adapterId, accountId: account.accountId, tenantId: account.tenantId },
              secret: input.secret,
            }
          }
        } else if (action === 'set-enabled') {
          const account = object(input.account)
          if (
            Object.keys(input).every(key =>
              ['action', 'expectedRevision', 'serviceGeneration', 'account', 'enabled'].includes(key)
            )
            && Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) >= 0
            && bounded(input.serviceGeneration, 512) && typeof input.enabled === 'boolean' && account
            && Object.keys(account).every(key => ['adapterId', 'accountId', 'tenantId'].includes(key))
            && (account.adapterId === 'feishu' || account.adapterId === 'lark')
            && bounded(account.accountId, 512) && bounded(account.tenantId, 512)
          ) {
            operation = {
              kind: 'manager-channel-credentials',
              action,
              sessionId: session.id,
              expectedRevision: input.expectedRevision,
              serviceGeneration: input.serviceGeneration,
              enabled: input.enabled,
              account: { adapterId: account.adapterId, accountId: account.accountId, tenantId: account.tenantId },
            }
          }
        } else if (action === 'resolve-tenant') {
          const account = object(input.account)
          if (
            Object.keys(input).every(key =>
              ['action', 'expectedRevision', 'serviceGeneration', 'account', 'tenantId'].includes(key)
            )
            && Number.isSafeInteger(input.expectedRevision) && (input.expectedRevision as number) >= 0
            && bounded(input.serviceGeneration, 512) && account
            && Object.keys(account).every(key => ['adapterId', 'accountId', 'tenantId'].includes(key))
            && (account.adapterId === 'feishu' || account.adapterId === 'lark')
            && bounded(account.accountId, 512) && account.tenantId === ''
            && (input.tenantId === undefined || bounded(input.tenantId, 512))
          ) {
            operation = {
              kind: 'manager-channel-credentials',
              action,
              sessionId: session.id,
              expectedRevision: input.expectedRevision,
              serviceGeneration: input.serviceGeneration,
              account: { adapterId: account.adapterId, accountId: account.accountId, tenantId: '' },
              ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
            }
          }
        } else if ((action === 'commit' || action === 'discard') && bounded(input.draftId, 128)) {
          const draft = input.draft === undefined ? undefined : object(input.draft)
          if (
            Object.keys(input).every(key =>
              (action === 'commit' ? ['action', 'draftId', 'draft'] : ['action', 'draftId']).includes(key)
            )
            && (input.draft === undefined
              || draft && Object.keys(draft).every(key => ['displayName', 'selectors'].includes(key)))
          ) {
            operation = {
              kind: 'manager-channel-credentials',
              action,
              sessionId: session.id,
              draftId: input.draftId,
              ...(draft === undefined ? {} : { draft }),
            }
          }
        }
        if (!operation) return json(response, 400, { error: 'INVALID_REQUEST' })
        session.channelCredentialsUsed = true
        return scopedReply(await scopedRequest(operation as unknown as PluginManagementRpcOperation, action !== 'view'))
      }
      if (url.pathname === '/api/managed-services') {
        const bounded = (value: unknown): value is string =>
          typeof value === 'string'
          && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
        const action = input.action
        let operation: Record<string, unknown> | undefined
        if (action === 'list' && Object.keys(input).every(key => key === 'action')) {
          operation = { kind: 'manager-service-auth', action, sessionId: session.id }
        } else if (
          (action === 'view' || action === 'prepare-login') && bounded(input.pluginId) && bounded(input.serviceId)
          && Object.keys(input).every(key =>
            (action === 'view'
              ? ['action', 'pluginId', 'serviceId']
              : ['action', 'pluginId', 'serviceId', 'pluginGeneration', 'bindingId']).includes(key)
          )
          && (action === 'view' || bounded(input.pluginGeneration) && bounded(input.bindingId))
        ) {
          operation = {
            kind: 'manager-service-auth',
            action,
            sessionId: session.id,
            pluginId: input.pluginId,
            serviceId: input.serviceId,
            ...(action === 'prepare-login'
              ? { pluginGeneration: input.pluginGeneration, bindingId: input.bindingId }
              : {}),
          }
        } else if (
          action === 'login' && bounded(input.leaseId)
          && Object.keys(input).every(key => ['action', 'leaseId'].includes(key))
        ) {
          operation = { kind: 'manager-service-auth', action, sessionId: session.id, leaseId: input.leaseId }
        }
        if (!operation) return json(response, 400, { error: 'INVALID_REQUEST' })
        session.managedServicesUsed = true
        return scopedReply(
          await scopedRequest(
            operation as unknown as PluginManagementRpcOperation,
            action !== 'list' && action !== 'view',
          ),
        )
      }
      if (url.pathname === '/api/model-services') {
        const capability = object(await scopedRequest({ kind: 'codex', operation: 'model-services:read', input: {} }))
        if (!activeSession()) return revoked()
        if (capability?.status !== 'ok' || capability.managerSafeWrite !== MODEL_SERVICE_SAFE_WRITE_CONTRACT) {
          return json(response, 409, { error: 'MODEL_SERVICE_SAFE_WRITE_UNAVAILABLE' })
        }
        const result = await scopedRequest({ kind: 'codex', operation: 'model-services:save', input }, true)
        return scopedReply(result)
      }
      if (url.pathname === '/api/plugin-configuration') {
        if (
          !['read', 'update', 'services', 'update-service'].includes(String(input.action))
          || typeof input.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(input.pluginId)
        ) return json(response, 400, { error: 'INVALID_REQUEST' })
        const operation = { ...input, kind: 'plugin-configuration' } as unknown as PluginManagementRpcOperation
        return scopedReply(
          await scopedRequest(operation, input.action === 'update' || input.action === 'update-service'),
        )
      }
      if (url.pathname === '/api/catalog') {
        if (input.action === 'refresh') {
          return scopedReply(await scopedRequest({ kind: 'refresh-catalog' }, true))
        }
        if (input.action === 'search' && typeof input.query === 'string' && input.query.length <= 512) {
          return scopedReply(await scopedRequest({ kind: 'query-catalog', query: { query: input.query } }))
        }
        return json(response, 400, { error: 'INVALID_REQUEST' })
      }
      if (url.pathname === '/api/permission-review') {
        if (!Number.isSafeInteger(input.expectedRevision) || input.userConfirmed !== true || !object(input.decision)) {
          return json(response, 400, { error: 'INVALID_REQUEST' })
        }
        const operation = { ...input, kind: 'permission-review-apply' } as unknown as PluginManagementRpcOperation
        return scopedReply(await scopedRequest(operation, true))
      }
      if (url.pathname === '/api/management') {
        const item = object(input.request)
        if (
          (input.kind !== 'plan' && input.kind !== 'execute') || !item
          || typeof item.kind !== 'string' || !managementKinds.has(item.kind)
          || input.kind === 'execute'
            && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0)
        ) return json(response, 400, { error: 'INVALID_REQUEST' })
        const operation = input as unknown as PluginManagementRpcOperation
        return scopedReply(await scopedRequest(operation, true))
      }
      return json(response, 404, { error: 'NOT_FOUND' })
    } catch (error) {
      // Reflect only closed categories, never backend exception text or request data.
      const code = error instanceof Error ? error.message : ''
      if (code === 'MANAGER_SESSION_REVOKED' || !activeSession()) {
        return revoked()
      }
      const category = ['MANAGER_OWNER_CHANGED', 'MANAGER_OWNER_UNAVAILABLE'].includes(code)
        ? code
        : request.method === 'POST'
        ? 'OPERATION_RESULT_UNKNOWN'
        : 'OWNER_UNAVAILABLE'
      return json(response, 503, { error: category })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MANAGER_LISTEN_FAILED')
  authority = `127.0.0.1:${address.port}`
  return {
    url: issueUrl(),
    issueUrl,
    revokeUrl,
    async close() {
      await Promise.allSettled([...bootstraps.keys()].map(retire))
      await Promise.allSettled([...sessions.keys()].map(retireSession))
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
