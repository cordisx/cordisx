import { randomBytes } from 'node:crypto'
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { ensureHomeConfig, type HomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../../config/home-config.js'
import { CatalogError, type DiscoveryConnection, type DiscoveryRequest } from './contracts.js'
import { withAbort } from './abort.js'
import { createDiscoveryRequestCapability, type DiscoveryFetch } from './request-capability.js'
import { ManagedCatalogState } from './managed-catalog-state.js'
import type { NativeManagedGatewayConnectionSession } from '../managed-service-native-connection.js'
import {
  type ManagedProviderRecord,
  managedProviderSettings,
  type ManagedProviderView,
  managedProviderView,
  parseManagedProviderRecord,
} from './managed-provider-schema.js'

const nonce = () => randomBytes(32).toString('base64url')
const failure = () => new CatalogError('credential-unavailable')
const recordsSource = (records: readonly ManagedProviderRecord[]) => JSON.stringify(records)

interface OwnerOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly appId?: string
  readonly fetcher?: DiscoveryFetch
}

/** Host composition only. Never register this object as a plugin context service or renderer global. */
export class ManagedProviderOwner {
  readonly #configPath: string
  readonly #appId: string
  readonly #profileId: string
  readonly #lock: string
  readonly #lockIdentity: { dev: number; ino: number }
  readonly #fetcher: DiscoveryFetch | undefined
  #records = new Map<string, ManagedProviderRecord>()
  #source = ''
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false
  #closePromise?: Promise<void>
  #leases = new Set<AbortController>()
  #listeners = new Set<() => void>()
  readonly #state: ManagedCatalogState

  private constructor(
    configPath: string,
    appId: string,
    profileId: string,
    lock: string,
    identity: { dev: number; ino: number },
    fetcher?: DiscoveryFetch,
  ) {
    this.#configPath = configPath
    this.#appId = appId
    this.#profileId = profileId
    this.#lock = lock
    this.#lockIdentity = identity
    this.#fetcher = fetcher
    this.#state = new ManagedCatalogState(`${lock}.state.v2.json`, () => this.#assertCurrent())
  }

  static async open(options: OwnerOptions): Promise<ManagedProviderOwner> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(options.profileId)) throw failure()
    const home = await realpath(options.homeDir)
    const configPath = path.join(home, 'config.json')
    await ensureHomeConfig({ configPath })
    const directory = path.join(home, 'state', 'host-provider-owners')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const metadata = await lstat(directory)
    if (
      !metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())
    ) {
      throw failure()
    }
    const lock = path.join(directory, `${options.profileId}.lock`)
    // A crashed owner needs explicit lock recovery. Never steal a possibly healthy owner's lease.
    try {
      await mkdir(lock, { mode: 0o700 })
    } catch {
      throw failure()
    }
    const identity = await lstat(lock)
    const owner = new ManagedProviderOwner(
      configPath,
      options.appId ?? 'codex',
      options.profileId,
      lock,
      identity,
      options.fetcher,
    )
    try {
      await owner.#load()
      return owner
    } catch {
      await owner.close()
      throw failure()
    }
  }

  snapshot(): readonly ManagedProviderView[] {
    if (this.#closed) return []
    return Object.freeze([...this.#records.values()].map(managedProviderView))
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Host-only configuration/cache/overlay state; never mount these methods on RPC. */
  readCatalogState(): Promise<unknown> {
    return this.#serial(() => this.#state.read())
  }
  writeCatalogState(value: unknown, authorized: () => boolean): Promise<void> {
    return this.#serial(() => this.#state.write(value, authorized))
  }

  validateCurrent(): Promise<void> {
    return this.#assertCurrent()
  }

  /** Only the native credential broker consumes this private session. Not an adapter capability. */
  async nativeConnection(
    id: string,
    admittedResponses: () => boolean = () => false,
  ): Promise<NativeManagedGatewayConnectionSession> {
    await this.#assertCurrent()
    const record = this.#records.get(id)
    if (!record || record.settings.protocol !== 'responses' && !admittedResponses()) {
      throw new CatalogError('unsupported')
    }
    await this.#assertCurrent()
    if (this.#records.get(id) !== record || record.settings.protocol !== 'responses' && !admittedResponses()) {
      throw new CatalogError('cancelled')
    }
    const endpoint = new URL(record.settings.endpoint)
    return Object.freeze({
      value: Object.freeze({
        service: { pluginId: 'cordisx-host', serviceId: id, generation: record.scopeRevision },
        endpoint: {
          origin: endpoint.origin,
          apiPath: endpoint.pathname as `/${string}`,
          auth: { scheme: 'bearer' as const, token: record.secret },
        },
        models: { generation: record.revision, defaultAlias: '', aliases: [] },
        cleanup: { authorityId: record.scopeRevision },
      }),
      dispose() {},
    })
  }

  /** capture must be a trusted Host-private prompt, not a renderer/plugin secret field. */
  save(
    input: { readonly id?: string; readonly expectedRevision?: string; readonly settings: unknown },
    capture?: (signal: AbortSignal) => Promise<string>,
    authorized: () => boolean = () => true,
  ): Promise<ManagedProviderView> {
    return this.#serial(async () => {
      if (!authorized()) throw new CatalogError('permission')
      await this.#assertCurrent()
      const settings = managedProviderSettings(input.settings)
      const prior = input.id === undefined ? undefined : this.#records.get(input.id)
      if (input.id !== undefined && (!prior || prior.revision !== input.expectedRevision)) {
        throw new CatalogError('source-invalid')
      }
      if (!prior && (input.expectedRevision !== undefined || !capture || this.#records.size >= 64)) {
        throw new CatalogError('source-invalid')
      }
      const abort = new AbortController()
      this.#leases.add(abort)
      const timer = setTimeout(() => abort.abort(), 60_000)
      timer.unref?.()
      try {
        const secret = capture
          ? await withAbort(capture(abort.signal), abort.signal)
          : prior!.secret
        await this.#assertCurrent()
        if (!authorized()) throw new CatalogError('permission')
        const changedScope = !prior || capture !== undefined || settings.endpoint !== prior.settings.endpoint
          || settings.protocol !== prior.settings.protocol
        if (changedScope && prior && settings.supplement.length) throw new CatalogError('source-invalid')
        const record = parseManagedProviderRecord({
          id: prior?.id ?? nonce(),
          revision: nonce(),
          scopeRevision: changedScope ? nonce() : prior!.scopeRevision,
          credentialRevision: capture ? nonce() : prior!.credentialRevision,
          credentialRef: capture ? nonce() : prior!.credentialRef,
          settings,
          secret,
        })
        const raw = JSON.stringify(record)
        if (raw.length > 16 * 1024) throw new CatalogError('source-invalid')
        const next = new Map(this.#records).set(record.id, record)
        await this.#commit(next, authorized)
        return managedProviderView(record)
      } finally {
        clearTimeout(timer)
        this.#leases.delete(abort)
        abort.abort()
      }
    })
  }

  remove(id: string, expectedRevision: string, authorized: () => boolean = () => true): Promise<void> {
    return this.#serial(async () => {
      if (!authorized()) throw new CatalogError('permission')
      await this.#assertCurrent()
      const prior = this.#records.get(id)
      if (!prior || prior.revision !== expectedRevision) throw new CatalogError('source-invalid')
      const next = new Map(this.#records)
      next.delete(id)
      await this.#commit(next, authorized)
    })
  }

  /** At most one fixed operation. No plugin-supplied adapter, URL, headers or credential lookup. */
  connection(id: string): DiscoveryConnection | undefined {
    const record = this.#records.get(id)
    if (
      this.#closed || !record || !record.settings.discoveryEnabled || record.settings.strategy.kind !== 'auto'
    ) return undefined
    const current = () => !this.#closed && this.#records.get(id) === record
    const endpoint = new URL(record.settings.endpoint)
    endpoint.pathname = endpoint.pathname.replace(/\/$/u, '')
    const baseUrl = endpoint.href.replace(/\/$/u, '')
    return Object.freeze({
      endpoint: record.settings.endpoint,
      providerName: record.settings.title,
      scopeRevision: record.scopeRevision,
      current,
      request: async (operation: DiscoveryRequest, externalSignal: AbortSignal) => {
        if (this.#leases.size >= 4) throw new CatalogError('temporary')
        const abort = new AbortController()
        this.#leases.add(abort)
        const timer = setTimeout(() => abort.abort(), 10_000)
        timer.unref?.()
        const signal = AbortSignal.any([externalSignal, abort.signal])
        try {
          await this.#assertCurrent()
          const request = createDiscoveryRequestCapability({
            operation: { origin: baseUrl, method: 'GET', path: '/models' },
            current: () => current() && !signal.aborted,
            bearer: async () => {
              await this.#assertCurrent()
              if (this.#records.get(id) !== record) throw new CatalogError('cancelled')
              return record.secret
            },
            ...(this.#fetcher ? { fetcher: this.#fetcher } : {}),
          })
          const response = await request(operation, signal)
          await this.#assertCurrent()
          if (!current()) throw new CatalogError('cancelled')
          return response
        } catch (error) {
          throw error instanceof CatalogError ? error : failure()
        } finally {
          clearTimeout(timer)
          this.#leases.delete(abort)
        }
      },
    })
  }

  async #load(): Promise<void> {
    const records = this.#profileRecords(await loadHomeConfig(this.#configPath))
    this.#source = recordsSource(records)
    this.#records = new Map(records.map(record => [record.id, record]))
  }

  async #assertCurrent(): Promise<void> {
    if (this.#closed) throw failure()
    const metadata = await lstat(this.#lock).catch(() => undefined)
    if (
      !metadata?.isDirectory() || metadata.dev !== this.#lockIdentity.dev || metadata.ino !== this.#lockIdentity.ino
    ) {
      this.#closed = true
      this.#revoke()
      throw failure()
    }
    const source = recordsSource(this.#profileRecords(await loadHomeConfig(this.#configPath)))
    if (source !== this.#source) {
      this.#closed = true
      this.#revoke()
      throw failure()
    }
    if (this.#closed) throw failure()
  }

  #profileRecords(config: HomeConfig): readonly ManagedProviderRecord[] {
    const profile = config.apps[this.#appId]?.profiles[this.#profileId]
    if (!profile) throw new CatalogError('source-invalid')
    return profile.managedProviders ?? []
  }

  async #commit(next: Map<string, ManagedProviderRecord>, authorized: () => boolean = () => true): Promise<void> {
    await this.#assertCurrent()
    if (!authorized()) throw new CatalogError('permission')
    const records = [...next.values()]
    const updated = await updateHomeConfigAtomic(current => {
      if (!authorized()) throw new CatalogError('permission')
      if (recordsSource(this.#profileRecords(current)) !== this.#source) throw new CatalogError('source-invalid')
      const app = current.apps[this.#appId]!
      const profile = app.profiles[this.#profileId]!
      return {
        ...current,
        apps: {
          ...current.apps,
          [this.#appId]: {
            ...app,
            profiles: {
              ...app.profiles,
              [this.#profileId]: { ...profile, managedProviders: records },
            },
          },
        },
      }
    }, { configPath: this.#configPath })
    this.#source = recordsSource(this.#profileRecords(updated))
    this.#records = next
    this.#revoke()
    if (this.#closed) return
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch { /* Reader isolation. */ }
    }
  }

  #revoke(): void {
    for (const lease of this.#leases) lease.abort()
    this.#leases.clear()
  }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const job = this.#tail.then(action).catch(error => {
      throw error instanceof CatalogError ? error : failure()
    })
    this.#tail = job.catch(() => undefined)
    return job
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#closed = true
      this.#revoke()
      this.#listeners.clear()
      await this.#tail
      this.#records.clear()
      const metadata = await lstat(this.#lock).catch(() => undefined)
      if (metadata?.dev === this.#lockIdentity.dev && metadata.ino === this.#lockIdentity.ino) await rmdir(this.#lock)
    })()
    return this.#closePromise
  }
}
