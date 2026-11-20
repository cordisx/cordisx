import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { PluginManagementRpcOperation } from '../launcher/management-rpc.js'
import type { ManagerOwner } from './manager-owner.js'

const assets = new URL('../../assets/manager/', import.meta.url)
const files: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/manager.js': 'manager.js',
  '/manager-schema.js': 'manager-schema.js',
  '/manager.css': 'manager.css',
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
  const sessions = new Map<string, number>()
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
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('x-frame-options', 'DENY')
    response.setHeader(
      'content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
    if (request.method === 'GET' && file !== undefined) {
      try {
        const contents = await readFile(new URL(file, assets))
        const extension = file.slice(file.lastIndexOf('.'))
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
        for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key)
        while (sessions.size >= 16) sessions.delete(sessions.keys().next().value!)
        sessions.set(token, Date.now() + 8 * 60 * 60_000)
        return json(response, 200, { token })
      } catch {
        return json(response, 400, { error: 'INVALID_REQUEST' })
      }
    }
    const token = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : ''
    const sessionDeadline = sessions.get(token)
    if (sessionDeadline === undefined || sessionDeadline <= Date.now()) {
      sessions.delete(token)
      return json(response, 401, { error: 'UNAUTHORIZED' })
    }
    sessions.set(token, Date.now() + 8 * 60 * 60_000)
    if (request.method === 'POST' && origin !== `http://${authority}`) {
      return json(response, 403, { error: 'INVALID_ORIGIN' })
    }
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const [management, services, rendererPlugins] = await Promise.allSettled([
          owner.request({ kind: 'query' }),
          owner.request({ kind: 'codex', operation: 'model-services:read', input: {} }),
          owner.request({ kind: 'plugin-configuration', action: 'list' } as unknown as PluginManagementRpcOperation),
        ])
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
      if (!input) return json(response, 400, { error: 'INVALID_REQUEST' })
      if (url.pathname === '/api/model-services') {
        const result = await owner.request({ kind: 'codex', operation: 'model-services:save', input })
        return json(response, 200, result)
      }
      if (url.pathname === '/api/plugin-configuration') {
        if (
          !['read', 'update', 'services', 'update-service'].includes(String(input.action))
          || typeof input.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(input.pluginId)
        ) return json(response, 400, { error: 'INVALID_REQUEST' })
        const operation = { ...input, kind: 'plugin-configuration' } as unknown as PluginManagementRpcOperation
        return json(response, 200, await owner.request(operation))
      }
      if (url.pathname === '/api/catalog') {
        if (input.action === 'refresh') return json(response, 200, await owner.request({ kind: 'refresh-catalog' }))
        if (input.action === 'search' && typeof input.query === 'string' && input.query.length <= 512) {
          return json(response, 200, await owner.request({ kind: 'query-catalog', query: { query: input.query } }))
        }
        return json(response, 400, { error: 'INVALID_REQUEST' })
      }
      if (url.pathname === '/api/permission-review') {
        if (!Number.isSafeInteger(input.expectedRevision) || input.userConfirmed !== true || !object(input.decision)) {
          return json(response, 400, { error: 'INVALID_REQUEST' })
        }
        const operation = { ...input, kind: 'permission-review-apply' } as unknown as PluginManagementRpcOperation
        return json(response, 200, await owner.request(operation))
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
        return json(response, 200, await owner.request(operation))
      }
      return json(response, 404, { error: 'NOT_FOUND' })
    } catch (error) {
      // Reflect only closed categories, never backend exception text or request data.
      const code = error instanceof Error ? error.message : ''
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
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
