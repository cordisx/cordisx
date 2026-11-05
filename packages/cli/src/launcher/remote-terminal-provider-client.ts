import { randomUUID } from 'node:crypto'
import {
  connectExistingTerminalProvider,
  type ExistingTerminalProviderSource,
} from './existing-terminal-provider-rpc.js'
import type { TerminalProviderRequest, TerminalProviderResult } from './terminal-provider.js'
import type { NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'

export interface RemotePreparedProvider {
  readonly provider: Readonly<Record<string, unknown>>
  readonly serviceGeneration: string
  validate(): Promise<boolean>
  dispose(): Promise<void>
}

/** Host-private broker-command config only; never accepts raw credentials or renderer tables. */
function verifiedProvider(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const allowed = ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'auth']
  if (
    Object.keys(value).some(key => !allowed.includes(key)) || value.wire_api !== 'responses'
    || value.requires_openai_auth !== false || typeof value.base_url !== 'string'
  ) {
    throw new Error('Invalid remote provider configuration')
  }
  const url = new URL(value.base_url)
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('Invalid remote provider endpoint')
  }
  const provider = structuredClone(value)
  if (provider.auth !== undefined) {
    const auth = provider.auth as Record<string, unknown>
    if (
      !auth || typeof auth !== 'object' || Array.isArray(auth)
      || Object.keys(auth).some(key => !['command', 'args', 'cwd', 'timeout_ms', 'refresh_interval_ms'].includes(key))
      || ![auth.command, auth.cwd].every(text => typeof text === 'string' && text.length > 0 && !/[\0\r\n]/u.test(text))
      || !Array.isArray(auth.args) || !auth.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))
      || ![auth.timeout_ms, auth.refresh_interval_ms].every(n =>
        Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 60_000
      )
    ) {
      throw new Error('Invalid remote provider broker command')
    }
    Object.freeze(auth.args)
    Object.freeze(auth)
  }
  return Object.freeze(provider)
}

/** A consumer of an existing authority, never a service activation or a startup reporter. */
export class RemoteTerminalProviderClient {
  readonly #listeners = new Set<() => void>()
  readonly #leases = new Set<RemotePreparedProvider>()
  readonly #waiters = new Set<AbortController>()
  readonly #known = new Set<string>()
  #providers: readonly NativeModelProviderCatalogEntry[] = []
  #poll: ReturnType<typeof setInterval>
  #closed = false
  #read: Promise<void> | undefined
  #request: Promise<(input: TerminalProviderRequest) => Promise<TerminalProviderResult>>
  #startup: Extract<TerminalProviderResult, { kind: 'list' }>['startup']
  #state: 'pending' | 'available' | 'unavailable' = 'pending'

  constructor(
    source: ExistingTerminalProviderSource,
    private readonly options: {
      readonly connect?: typeof connectExistingTerminalProvider
      readonly now?: () => number
    } = {},
  ) {
    this.#request = (options.connect ?? connectExistingTerminalProvider)(source)
    void this.refresh().catch(() => undefined)
    this.#poll = setInterval(() => {
      void this.refresh().catch(() => undefined)
    }, 10_000)
    this.#poll.unref()
  }

  get state() {
    return this.#state
  }
  /** Missing legacy startup stays unknown; a list is not an activation readiness acknowledgement. */
  get startup() {
    return this.#startup
  }
  catalog = async () => this.#providers
  owns = (providerId: string) => this.#known.has(providerId)
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  refresh(): Promise<void> {
    if (this.#read) return this.#read
    const previous = JSON.stringify([this.#state, this.#providers, this.#startup])
    this.#read = (async () => {
      try {
        if (this.#closed) throw new Error('Remote provider consumer closed')
        const result = await (await this.#request)({ kind: 'list' })
        if (this.#closed || result.kind !== 'list') throw new Error('Remote catalog unavailable')
        const providers = result.providers.filter(provider => provider.managed)
        const ids = new Set<string>()
        const projection = providers.map(provider => {
          if (
            !provider.providerId || ids.has(provider.providerId) || provider.providerId === 'openai'
            || !Array.isArray(provider.models)
          ) throw new Error('Invalid remote catalog')
          ids.add(provider.providerId)
          const models = new Set<string>()
          return Object.freeze({
            providerId: provider.providerId,
            // Explicit catalog provenance; this is not a local plugin/service identity.
            pluginId: 'remote-terminal-provider',
            managementOwner: 'remote' as const,
            title: provider.title,
            models: Object.freeze(provider.models.map(model => {
              if (!model.id || models.has(model.id)) throw new Error('Invalid remote model')
              models.add(model.id)
              return Object.freeze({ id: model.id, label: model.label, aliases: Object.freeze([]) })
            })),
          })
        })
        for (const id of ids) this.#known.add(id)
        this.#providers = Object.freeze(projection)
        this.#startup = result.startup
        this.#state = 'available'
      } catch (error) {
        this.#providers = []
        this.#startup = undefined
        this.#state = 'unavailable'
        throw error
      } finally {
        if (JSON.stringify([this.#state, this.#providers, this.#startup]) !== previous) {
          for (const listener of this.#listeners) {
            try {
              listener()
            } catch {
              /* Subscriber isolation. */
            }
          }
        }
      }
    })().finally(() => {
      this.#read = undefined
    })
    return this.#read
  }

  async validateSelection(selection: { providerId: string; model: string }): Promise<boolean> {
    try {
      await this.refresh()
      return !this.#closed && this.#providers.some(provider =>
        provider.providerId === selection.providerId
        && provider.models.some(model => model.id === selection.model)
      )
    } catch {
      return false
    }
  }

  async prepare(
    selection: { providerId: string; model: string },
    signal?: AbortSignal,
  ): Promise<RemotePreparedProvider> {
    const waiter = new AbortController()
    const waiterId = randomUUID()
    const now = this.options.now ?? Date.now
    let lease: RemotePreparedProvider | undefined
    let prepared: Extract<TerminalProviderResult, { kind: 'prepared' }> | undefined
    const request = await this.#request
    const cancel = () => {
      waiter.abort()
    }
    this.#waiters.add(waiter)
    waiter.signal.addEventListener('abort', () => {
      void request({ kind: 'cancel-wait', waiterId }).catch(() => undefined)
    }, { once: true })
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (signal?.aborted || this.#closed) throw new Error('Remote provider preparation cancelled')
      if (!await this.validateSelection(selection)) throw new Error('Remote selection unavailable')
      waiter.signal.throwIfAborted()
      const result = await request({
        kind: 'prepare',
        providerId: selection.providerId,
        model: selection.model,
        waiterId,
      })
      if (result.kind !== 'prepared') throw new Error('Remote provider preparation unavailable')
      prepared = result
      if (
        result.providerId !== selection.providerId || result.model !== selection.model || !result.leaseId
        || this.#closed || waiter.signal.aborted || signal?.aborted
      ) throw new Error('Remote provider acknowledgement stale')
      const provider = verifiedProvider(result.provider)
      let expires = now() + 60_000
      let retired = false
      let renewing: Promise<boolean> | undefined
      const renew = (): Promise<boolean> => {
        if (renewing) return renewing
        renewing = (async () => {
          try {
            if (retired || this.#closed || expires <= now() || !await this.validateSelection(selection)) return false
            const ack = await request({ kind: 'renew', leaseId: result.leaseId })
            if (retired || this.#closed || expires <= now() || ack.kind !== 'renewed') return false
            expires = now() + 60_000
            return true
          } catch {
            return false
          }
        })().then(async valid => {
          if (!valid) await lease!.dispose()
          return valid
        }).finally(() => {
          renewing = undefined
        })
        return renewing
      }
      const timer = setInterval(() => {
        void renew()
      }, 10_000)
      timer.unref()
      lease = {
        provider,
        // The original authority checks its actual service generation on every renew.
        serviceGeneration: `remote-${result.leaseId}`,
        validate: renew,
        dispose: async () => {
          if (retired) return
          retired = true
          clearInterval(timer)
          this.#leases.delete(lease!)
          await request({ kind: 'release', leaseId: result.leaseId }).catch(() => undefined)
        },
      }
      this.#leases.add(lease)
      if (!await lease.validate() || waiter.signal.aborted || signal?.aborted) {
        throw new Error('Remote lease unavailable')
      }
      return lease
    } catch (error) {
      if (lease) await lease.dispose()
      else if (prepared) await request({ kind: 'release', leaseId: prepared.leaseId }).catch(() => undefined)
      // Also retires a lease whose prepare response was lost after acquisition.
      await request({ kind: 'cancel-wait', waiterId }).catch(() => undefined)
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
      this.#waiters.delete(waiter)
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#poll)
    this.#providers = []
    this.#listeners.clear()
    for (const waiter of this.#waiters) waiter.abort()
    await Promise.allSettled([...this.#leases].map(lease => lease.dispose()))
  }
}
