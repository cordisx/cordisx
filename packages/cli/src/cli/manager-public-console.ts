import { randomBytes } from 'node:crypto'
import { canonicalManagerBrowserOrigin } from '../independent-manager/manager-browser-origin.js'
import { canonicalManagedConsoleBrowserOrigins } from '../launcher/managed-console-browser-gateway.js'
import { ManagerPublicConsoleCookies } from './manager-public-console-cookies.js'

export interface ManagerPublicConsoleRoute {
  readonly publicOrigin: string
  readonly localOrigin: string
  readonly cookies: ManagerPublicConsoleCookies
  readonly signal: AbortSignal
}

export interface ManagerPublicConsoleMapping {
  /** Frame policy sources; each issued origin also has an unpredictable hostname. */
  readonly origins: readonly string[]
  issue(localOrigin: string, view: string, signal: AbortSignal): ManagerPublicConsoleRoute | undefined
  resolve(authority: string): ManagerPublicConsoleRoute | undefined
  retire(view: string): void
  close(): void
}

/** A fresh hostname keeps browser authentication caches separate across retired views. */
export function managerPublicConsoleTemplate(
  value: unknown,
): { readonly template: string; readonly frameSource: string } {
  if (typeof value !== 'string' || value.split('{view}').length !== 2 || /[{}]/u.test(value.replace('{view}', ''))) {
    throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
  }
  const marker = 'cx-view-placeholder'
  const sample = canonicalManagerBrowserOrigin(value.replace('{view}', marker))
  const url = new URL(sample)
  if (!url.hostname.startsWith(marker + '.')) throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
  return { template: sample.replace(marker, '{view}'), frameSource: sample.replace(marker, '*') }
}

/** Pair only current owner listeners with deployment-configured hostname templates. */
export function createManagerPublicConsoleMapping(
  managerOrigin: string,
  localOrigins: readonly string[] | undefined,
  publicTemplates: readonly string[],
): ManagerPublicConsoleMapping {
  if (!localOrigins || localOrigins.length === 0 || localOrigins.length !== publicTemplates.length) {
    throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
  }
  const locals = canonicalManagedConsoleBrowserOrigins(localOrigins)
  const templates = publicTemplates.map(managerPublicConsoleTemplate)
  const routes = new Map<string, {
    route: ManagerPublicConsoleRoute
    view: string
    signal: AbortSignal
    abort: () => void
    controller: AbortController
  }>()
  const views = new Map<string, string>()
  const retired = new Map<string, number>()
  let closed = false
  const dispose = (view: string) => {
    const authority = views.get(view)
    if (!authority) return
    const entry = routes.get(authority)
    views.delete(view)
    if (!entry || entry.view !== view) return
    routes.delete(authority)
    entry.signal.removeEventListener('abort', entry.abort)
    entry.controller.abort()
    entry.route.cookies.clear()
  }
  const prune = () => {
    const now = Date.now()
    for (const [view, expires] of retired) if (expires <= now) retired.delete(view)
  }
  const retire = (view: string) => {
    if (closed) return
    prune()
    if (!retired.has(view) && retired.size >= 4_096) {
      closed = true
      for (const active of [...views.keys()]) dispose(active)
      retired.clear()
      return
    }
    // A delayed issue response must not resurrect a view the browser has left.
    retired.set(view, Date.now() + 60_000)
    dispose(view)
  }
  return {
    origins: [...new Set(templates.map(item => item.frameSource))],
    issue(localOrigin, view, signal) {
      const index = locals.indexOf(localOrigin)
      if (closed || index < 0 || !view || signal.aborted) throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
      prune()
      if (retired.has(view)) return undefined
      dispose(view)
      for (const entry of routes.values()) if (entry.route.localOrigin === localOrigin) retire(entry.view)
      if (closed) throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
      let publicOrigin: string
      let authority: string
      do {
        publicOrigin = templates[index]!.template.replace('{view}', randomBytes(16).toString('hex'))
        authority = new URL(publicOrigin).host
      } while (publicOrigin === managerOrigin || routes.has(authority))
      const controller = new AbortController()
      const route = { publicOrigin, localOrigin, cookies: new ManagerPublicConsoleCookies(), signal: controller.signal }
      const abort = () => retire(view)
      routes.set(authority, { route, view, signal, abort, controller })
      views.set(view, authority)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        retire(view)
        throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
      }
      return route
    },
    resolve: authority => routes.get(authority)?.route,
    retire,
    close() {
      if (closed) return
      closed = true
      for (const view of [...views.keys()]) dispose(view)
      retired.clear()
    },
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function parseManagerPublicConsoleRequest(
  envelope: Record<string, unknown>,
  sessionId: string,
  signal: AbortSignal,
): { readonly action: 'issue' | 'retire'; readonly view: string; readonly signal: AbortSignal } | undefined {
  const request = object(envelope.request)
  if (
    (request?.action !== 'issue' && request?.action !== 'retire') || typeof request.viewId !== 'string'
    || typeof envelope.token !== 'string' || typeof envelope.serviceId !== 'string'
  ) return undefined
  return {
    action: request.action,
    view: JSON.stringify([sessionId, envelope.token, envelope.serviceId, request.viewId]),
    signal,
  }
}

/** The owner has already validated the lease; never send its loopback URL to a remote browser. */
export function projectManagerPublicConsoleResult(
  value: unknown,
  mapping: ManagerPublicConsoleMapping | undefined,
  request: { readonly action: 'issue' | 'retire'; readonly view: string; readonly signal: AbortSignal },
) {
  const envelope = object(value)
  const result = object(envelope?.value)
  if (envelope?.ok === true && request.action === 'retire') {
    mapping?.retire(request.view)
    return value
  }
  if (envelope?.ok !== true || result?.status !== 'available') return value
  if (request.action !== 'issue') throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
  if (!mapping) return { ...envelope, value: { status: 'unavailable', reason: 'unsupported' } }
  if (typeof result.origin !== 'string' || typeof result.url !== 'string') {
    throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
  }
  const local = new URL(result.url)
  if (
    local.origin !== result.origin || local.username || local.password || local.hash
    || !local.pathname.startsWith('/') || local.pathname.startsWith('//')
    || [...local.searchParams.keys()].join(',') !== 'ticket'
    || !/^[A-Za-z0-9_-]{32}$/u.test(local.searchParams.get('ticket') ?? '')
  ) throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
  const route = mapping.issue(result.origin, request.view, request.signal)
  if (!route) return { ...envelope, value: { status: 'unavailable', reason: 'cancelled' } }
  const destination = new URL(local.pathname + local.search, route.publicOrigin)
  if (destination.origin !== route.publicOrigin) throw new Error('MANAGER_CONSOLE_MAPPING_INVALID')
  return { ...envelope, value: { ...result, origin: route.publicOrigin, url: destination.href } }
}
