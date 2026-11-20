import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { PluginManagementRpcOperation } from '../launcher/management-rpc.js'
import type { ManagerOwner } from './manager-owner.js'
import { MODEL_SERVICE_SAFE_WRITE_CONTRACT } from '../model-service-contracts.js'

const assets = new URL('../../assets/manager/', import.meta.url)
const files: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/manager.js': 'manager.js',
  '/manager-shell.js': 'manager-shell.js',
  '/manager-schema.js': 'manager-schema.js',
  '/manager-channel-ui.js': 'manager-channel-ui.js',
  '/manager.css': 'manager.css',
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
export async function startManagerWeb(owner: ManagerOwner) {
  const bootstraps = new Map<string, { deadline: number; timer: NodeJS.Timeout; retire?: () => Promise<void> }>()
  type BrowserSession = {
    id: string
    deadline: number
    timer: NodeJS.Timeout
    controller: AbortController
    managedServicesUsed: boolean
    channelCredentialsUsed: boolean
  }
  const sessions = new Map<string, BrowserSession>()
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
    if (!session) return
    sessions.delete(token)
    clearTimeout(session.timer)
    session.controller.abort()
    const retireKinds = [
      ...(session.managedServicesUsed ? ['manager-service-auth'] : []),
      ...(session.channelCredentialsUsed ? ['manager-channel-credentials'] : []),
    ]
    await Promise.allSettled(retireKinds.map(kind => {
      const operation = { kind, action: 'retire', sessionId: session.id }
      return owner.request(operation as unknown as PluginManagementRpcOperation, { timeoutMs: 1_000 })
    }))
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
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
    const file = files[url.pathname]
    const shared = sharedStyles[url.pathname]
    if (request.method === 'GET' && (file !== undefined || shared !== undefined)) {
      try {
        const contents = await readFile(shared ?? new URL(file!, assets)).catch(async error => {
          // Source-mode development serves the shell built into dist; packaged
          // execution resolves it directly from the normal assets directory.
          if (file !== 'manager-shell.js') throw error
          return await readFile(new URL('../../dist/assets/manager/manager-shell.js', import.meta.url))
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
