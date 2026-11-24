import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service/v1'
import type { ManagedServiceUIBindingRequest } from '../launcher/managed-service-ui-rpc.js'
import { canonicalManagedServiceWebOrigin } from '../launcher/managed-service-web-entry.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { ManagerManagedServiceUICapability } from './manager-managed-service-ui.js'

type WebRequest = Extract<ManagedServiceUIBindingRequest, { readonly operation: 'readWebEntry' | 'cancelWebEntry' }>
type BrowserRequest = Extract<ManagedServiceUIBindingRequest, { readonly operation: 'consoleBrowser' }>
interface Alias {
  readonly public: ManagerManagedServiceUICapability
  readonly ownerToken: string
}
interface Descriptor {
  readonly contract: 'cordisx.managed-service-web-entry/v1'
  readonly binding: ManagedServiceBindingV1
  readonly serviceGeneration: string
  readonly timeoutMs: number
}
interface Entry {
  readonly alias: Alias
  readonly serviceId: string
  readonly parentBinding: ManagedServiceBindingV1
  readonly owner: Descriptor
  readonly public: Descriptor
  readonly browser: boolean
}
interface Pending {
  readonly entry: Entry
  readonly ownerRequestId: string
  readonly done: Promise<void>
}
interface View {
  readonly entry: Entry
  readonly ownerViewId: string
  readonly publicViewId: string
  readonly issueSettled: Promise<void>
  retirement?: Promise<boolean>
}
const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const webCodes = new Set([
  'unsupported',
  'owner-unavailable',
  'service-unavailable',
  'stale-generation',
  'binding-replaced',
  'disposed',
  'cancelled',
  'timeout',
  'invalid-source',
  'ownership-unverified',
])
const consoleReasons = new Set([
  'unsupported',
  'sign-in-required',
  'owner-unavailable',
  'stale-generation',
  'cancelled',
  'failed',
])

function unavailable(): Error {
  return new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
}
function key(alias: Alias, serviceId: string): string {
  return alias.public.token + '\u0000' + serviceId
}

/** Web entries and browser views belong to one admitted Manager renderer. */
export class ManagerManagedServiceWebEntry {
  private readonly entries = new Map<string, Entry>()
  private readonly pending = new Map<string, Pending>()
  private readonly usedRequests = new Set<string>()
  private readonly views = new Map<string, View>()
  private readonly usedViews = new Set<string>()
  private closed = false
  private uncertain = false
  private retirement: Promise<boolean> | undefined

  constructor(
    private readonly input: {
      readonly context: ManagerRendererChannelContext
      readonly runtimeGeneration: string
      readonly consoleOrigins: readonly string[]
      readonly allocateId: () => string
      readonly assertCurrent: () => void
      readonly onUncertain: () => void
      readonly invoke: (value: string, signal?: AbortSignal) => Promise<Record<string, unknown>>
      readonly sanitize: (value: unknown, requestId: string) => Record<string, unknown>
    },
  ) {}

  project(
    alias: Alias,
    serviceId: string,
    parentBinding: ManagedServiceBindingV1,
    raw: unknown,
    rawConsole: unknown,
  ): { readonly webEntry?: Descriptor; readonly authenticatedConsole?: Record<string, unknown> } {
    if (this.closed) throw unavailable()
    const entryKey = key(alias, serviceId)
    const previous = this.entries.get(entryKey)
    if (raw === undefined) {
      if (previous) throw unavailable()
      return {}
    }
    const value = object(raw)
    const binding = object(value.binding)
    if (
      !exact(value, ['contract', 'binding', 'serviceGeneration', 'timeoutMs'])
      || value.contract !== 'cordisx.managed-service-web-entry/v1'
      || !exact(binding, ['bindingId', 'identity', 'scope'])
      || typeof binding.bindingId !== 'string' || !opaqueId.test(binding.bindingId)
      || !isDeepStrictEqual(binding.identity, parentBinding.identity)
      || !isDeepStrictEqual(binding.scope, parentBinding.scope)
      || typeof value.serviceGeneration !== 'string' || !opaqueId.test(value.serviceGeneration)
      || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1
      || (value.timeoutMs as number) > 300_000
    ) throw unavailable()
    let browser = false
    if (rawConsole !== undefined) {
      const console = object(rawConsole)
      if (
        console.contract === 'cordisx.managed-service-console/v1' && console.browserEntry === true
        && console.nativeMount === false && console.serviceGeneration === value.serviceGeneration
        && exact(console, ['contract', 'serviceGeneration', 'nativeMount', 'browserEntry'])
      ) browser = true
    }
    const owner = value as unknown as Descriptor
    let entry = previous
    if (
      !entry || !isDeepStrictEqual(entry.owner, owner) || !isDeepStrictEqual(entry.parentBinding, parentBinding)
      || entry.browser !== browser
    ) {
      if (
        entry && ([...this.pending.values()].some(item => item.entry === entry)
          || [...this.views.values()].some(item => item.entry === entry))
      ) throw unavailable()
      const publicBinding = { ...owner.binding, bindingId: this.input.allocateId() }
      entry = { alias, serviceId, parentBinding, owner, public: { ...owner, binding: publicBinding }, browser }
      this.entries.set(entryKey, entry)
    }
    return {
      webEntry: entry.public,
      ...(entry.browser
        ? {
          authenticatedConsole: {
            contract: 'cordisx.managed-service-console/v1',
            serviceGeneration: owner.serviceGeneration,
            nativeMount: false,
            browserEntry: true,
          },
        }
        : {}),
    }
  }

  prepareWeb(alias: Alias, request: WebRequest) {
    const entry = this.entries.get(key(alias, request.serviceId))
    if (
      this.closed || !entry || !isDeepStrictEqual(request.binding, entry.public.binding)
      || request.request.serviceGeneration !== entry.public.serviceGeneration
    ) throw unavailable()
    return {
      mode: 'read' as const,
      ...(request.operation === 'readWebEntry' ? { longLivedRead: true as const } : {}),
      dispatch: async () => await this.dispatchWeb(entry, request),
    }
  }

  prepareBrowser(alias: Alias, request: BrowserRequest) {
    const entry = this.entries.get(key(alias, request.serviceId))
    if (
      this.closed || !entry?.browser || !isDeepStrictEqual(request.binding, entry.parentBinding)
      || request.request.serviceGeneration !== entry.owner.serviceGeneration
    ) throw unavailable()
    return { mode: 'read' as const, dispatch: async () => await this.dispatchBrowser(entry, request) }
  }

  private envelope(entry: Entry, request: Record<string, unknown>): string {
    return JSON.stringify({
      version: 1,
      token: entry.alias.ownerToken,
      scope: {
        profileId: this.input.context.profileId,
        runtimeGeneration: this.input.runtimeGeneration,
        pluginGeneration: entry.alias.public.pluginGeneration,
      },
      ...request,
    })
  }

  private webResult(entry: Entry, value: unknown): Record<string, unknown> {
    const result = object(value)
    const common = ['contract', 'binding', 'serviceGeneration', 'status']
    if (
      result.contract !== 'cordisx.managed-service-web-entry-result/v1'
      || !isDeepStrictEqual(result.binding, entry.owner.binding)
      || result.serviceGeneration !== entry.owner.serviceGeneration
    ) throw unavailable()
    if (result.status === 'available' && exact(result, [...common, 'origin'])) {
      return { ...result, binding: entry.public.binding, origin: canonicalManagedServiceWebOrigin(result.origin) }
    }
    if (
      result.status === 'unavailable' && exact(result, [...common, 'code'])
      && typeof result.code === 'string' && webCodes.has(result.code)
    ) {
      return { ...result, binding: entry.public.binding }
    }
    throw unavailable()
  }

  private async dispatchWeb(entry: Entry, request: WebRequest): Promise<Record<string, unknown>> {
    this.input.assertCurrent()
    if (this.closed || this.entries.get(key(entry.alias, entry.serviceId)) !== entry) throw unavailable()
    const publicKey = key(entry.alias, request.requestId)
    const target = request.operation === 'cancelWebEntry'
      ? this.pending.get(key(entry.alias, request.targetRequestId))
      : undefined
    if (request.operation === 'cancelWebEntry' && (!target || target.entry !== entry)) {
      return {
        requestId: request.requestId,
        ok: true,
        value: {
          contract: 'cordisx.managed-service-web-entry-result/v1',
          binding: entry.public.binding,
          serviceGeneration: entry.public.serviceGeneration,
          status: 'unavailable',
          code: 'cancelled',
        },
      }
    }
    if (this.usedRequests.has(publicKey) || this.usedRequests.size >= 4_096) throw unavailable()
    this.usedRequests.add(publicKey)
    const ownerRequestId = 'manager-web-' + randomBytes(16).toString('hex')
    const body = {
      requestId: ownerRequestId,
      operation: request.operation,
      serviceId: entry.serviceId,
      binding: entry.owner.binding,
      request: { ...request.request, binding: entry.owner.binding },
      ...(target ? { targetRequestId: target.ownerRequestId } : {}),
    }
    let finish!: () => void
    const done = new Promise<void>(resolve => {
      finish = resolve
    })
    if (request.operation === 'readWebEntry') this.pending.set(publicKey, { entry, ownerRequestId, done })
    try {
      const result = this.input.sanitize(
        await this.input.invoke(this.envelope(entry, body), this.input.context.signal),
        ownerRequestId,
      )
      this.input.assertCurrent()
      if (this.closed || this.entries.get(key(entry.alias, entry.serviceId)) !== entry) throw unavailable()
      return result.ok === false
        ? { ...result, requestId: request.requestId }
        : { requestId: request.requestId, ok: true, value: this.webResult(entry, result.value) }
    } finally {
      if (request.operation === 'readWebEntry') this.pending.delete(publicKey)
      finish()
    }
  }

  private async dispatchBrowser(entry: Entry, request: BrowserRequest): Promise<Record<string, unknown>> {
    this.input.assertCurrent()
    if (this.closed || this.entries.get(key(entry.alias, entry.serviceId)) !== entry) throw unavailable()
    const viewKey = key(entry.alias, request.request.viewId)
    let view = this.views.get(viewKey)
    let finishIssue = () => {}
    if (request.request.action === 'issue') {
      if (this.usedViews.has(viewKey) || this.usedViews.size >= 4_096) throw unavailable()
      this.usedViews.add(viewKey)
      const issueSettled = new Promise<void>(resolve => finishIssue = resolve)
      view = { entry, publicViewId: request.request.viewId, ownerViewId: this.input.allocateId(), issueSettled }
      this.views.set(viewKey, view)
    } else {
      if (!view || view.entry !== entry) {
        return { requestId: request.requestId, ok: true, value: { status: 'unavailable', reason: 'cancelled' } }
      }
      return await this.dispatchBrowserRetirement(viewKey, view, request.requestId)
    }
    try {
      const ownerRequestId = 'manager-console-' + randomBytes(16).toString('hex')
      let result: Record<string, unknown>
      try {
        result = this.input.sanitize(
          await this.input.invoke(
            this.envelope(entry, {
              requestId: ownerRequestId,
              operation: 'consoleBrowser',
              serviceId: entry.serviceId,
              binding: entry.parentBinding,
              request: { ...request.request, viewId: view.ownerViewId },
            }),
            this.input.context.signal,
          ),
          ownerRequestId,
        )
      } finally {
        finishIssue()
      }
      this.input.assertCurrent()
      if (this.closed) throw unavailable()
      if (result.ok === false) throw unavailable()
      const value = object(result.value)
      if (
        value.status === 'unavailable' && exact(value, ['status', 'reason'])
        && typeof value.reason === 'string' && consoleReasons.has(value.reason)
      ) {
        if (this.views.get(viewKey) === view) this.views.delete(viewKey)
        return { requestId: request.requestId, ok: true, value }
      }
      if (
        this.views.get(viewKey) !== view || view.retirement !== undefined
        || !exact(value, ['status', 'binding', 'serviceGeneration', 'origin', 'url'])
        || value.status !== 'available' || !isDeepStrictEqual(value.binding, entry.parentBinding)
        || value.serviceGeneration !== entry.owner.serviceGeneration || typeof value.origin !== 'string'
        || !this.input.consoleOrigins.includes(value.origin)
        || typeof value.url !== 'string'
      ) throw unavailable()
      const url = new URL(value.url)
      if (
        url.origin !== value.origin || url.username || url.password || url.hash
        || [...url.searchParams.keys()].join(',') !== 'ticket'
        || !/^[A-Za-z0-9_-]{32}$/u.test(url.searchParams.get('ticket') ?? '')
      ) throw unavailable()
      return { requestId: request.requestId, ok: true, value }
    } catch (error) {
      finishIssue()
      const retired = await this.retireView(view).catch(() => false)
      if (retired && this.views.get(viewKey) === view) this.views.delete(viewKey)
      if (!retired) {
        this.uncertain = true
        this.input.onUncertain()
      }
      throw error
    }
  }

  private async dispatchBrowserRetirement(viewKey: string, view: View, requestId: string) {
    let confirmed = false
    try {
      confirmed = await this.retireView(view)
      if (!confirmed) throw unavailable()
      if (this.views.get(viewKey) === view) this.views.delete(viewKey)
      this.input.assertCurrent()
      if (this.closed) throw unavailable()
      return { requestId, ok: true, value: { status: 'unavailable', reason: 'cancelled' } }
    } catch (error) {
      if (!confirmed) {
        this.uncertain = true
        this.input.onUncertain()
      }
      throw error
    }
  }

  private retireView(view: View): Promise<boolean> {
    return view.retirement ??= this.performRetireView(view)
  }

  private async performRetireView(view: View): Promise<boolean> {
    await view.issueSettled
    if (this.input.context.signal.aborted) return true
    const requestId = 'manager-console-retire-' + randomBytes(16).toString('hex')
    const result = this.input.sanitize(
      await this.input.invoke(
        this.envelope(view.entry, {
          requestId,
          operation: 'consoleBrowser',
          serviceId: view.entry.serviceId,
          binding: view.entry.parentBinding,
          request: {
            action: 'retire',
            viewId: view.ownerViewId,
            serviceGeneration: view.entry.owner.serviceGeneration,
          },
        }),
        this.input.context.signal,
      ),
      requestId,
    )
    return result.ok === true && isDeepStrictEqual(result.value, { status: 'unavailable', reason: 'cancelled' })
  }

  retire(): Promise<boolean> {
    if (this.retirement) return this.retirement
    this.closed = true
    const pending = [...this.pending.values()]
    const views = [...this.views.values()]
    this.views.clear()
    const cleanup = [
      ...pending.map(async item => {
        const requestId = 'manager-web-retire-' + randomBytes(16).toString('hex')
        const result = this.input.sanitize(
          await this.input.invoke(this.envelope(item.entry, {
            requestId,
            operation: 'cancelWebEntry',
            serviceId: item.entry.serviceId,
            binding: item.entry.owner.binding,
            request: {
              contract: 'cordisx.managed-service-web-entry-read/v1',
              binding: item.entry.owner.binding,
              serviceGeneration: item.entry.owner.serviceGeneration,
            },
            targetRequestId: item.ownerRequestId,
          })),
          requestId,
        )
        await item.done
        return result.ok === true && this.webResult(item.entry, result.value).code === 'cancelled'
      }),
      ...views.map(async view => await this.retireView(view)),
    ]
    this.retirement = Promise.race([
      Promise.allSettled(cleanup).then(results =>
        !this.uncertain && results.every(result => result.status === 'fulfilled' && result.value)
      ),
      new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 8_000)
        timer.unref()
      }),
    ])
    return this.retirement
  }
}
