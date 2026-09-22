import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { createMacOSKeychainBackend, type LauncherKeychainBackend } from '../secret-store.js'
import { CatalogError, type DiscoveryConnection, type DiscoveryRequest, object } from './contracts.js'
import { withAbort } from './abort.js'
import { createDiscoveryRequestCapability, type DiscoveryFetch } from './request-capability.js'
import {
  type ManagedProviderRecord,
  managedProviderSettings,
  type ManagedProviderView,
  managedProviderView,
  opaqueProviderId,
  parseManagedProviderRecord,
} from './managed-provider-schema.js'

const nonce = () => randomBytes(32).toString('base64url')
const failure = () => new CatalogError('credential-unavailable')
type StoredEntry = { ref: string; value: Omit<ManagedProviderRecord, 'secret'> }
const metadataOf = ({ secret: _secret, ...value }: ManagedProviderRecord) => Object.freeze(value)

interface OwnerOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly keychain?: LauncherKeychainBackend
  readonly fetcher?: DiscoveryFetch
  readonly platform?: NodeJS.Platform
}

/** Host composition only. Never register this object as a plugin context service or renderer global. */
export class ManagedProviderOwner {
  readonly #backend: LauncherKeychainBackend
  readonly #service: string
  readonly #lock: string
  readonly #lockIdentity: { dev: number; ino: number }
  readonly #fetcher: DiscoveryFetch | undefined
  #records = new Map<string, StoredEntry>()
  #retired: string[] = []
  #index = ''
  #tail: Promise<unknown> = Promise.resolve()
  #closed = false
  #closePromise?: Promise<void>
  #leases = new Set<AbortController>()
  #listeners = new Set<() => void>()

  private constructor(
    backend: LauncherKeychainBackend,
    service: string,
    lock: string,
    identity: { dev: number; ino: number },
    fetcher?: DiscoveryFetch,
  ) {
    this.#backend = backend
    this.#service = service
    this.#lock = lock
    this.#lockIdentity = identity
    this.#fetcher = fetcher
  }

  static async open(options: OwnerOptions): Promise<ManagedProviderOwner> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(options.profileId)) throw failure()
    if (!options.keychain && (options.platform ?? process.platform) !== 'darwin') throw failure()
    const home = await realpath(options.homeDir)
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
    const scope = createHash('sha256').update(JSON.stringify([home, options.profileId])).digest('hex')
    const owner = new ManagedProviderOwner(
      options.keychain ?? createMacOSKeychainBackend(),
      `cordisx/host-provider/v1/${scope}`,
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
    return Object.freeze([...this.#records.values()].map(record => managedProviderView(record.value)))
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
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
      await this.#cleanup()
      const settings = managedProviderSettings(input.settings)
      const prior = input.id === undefined ? undefined : this.#records.get(input.id)
      if (input.id !== undefined && (!prior || prior.value.revision !== input.expectedRevision)) {
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
          : (await this.#readRecord(prior!)).secret
        await this.#assertCurrent()
        if (!authorized()) throw new CatalogError('permission')
        const changedScope = !prior || capture !== undefined || settings.endpoint !== prior.value.settings.endpoint
          || settings.protocol !== prior.value.settings.protocol
        if (changedScope && prior && settings.supplement.length) throw new CatalogError('source-invalid')
        const record = parseManagedProviderRecord({
          id: prior?.value.id ?? nonce(),
          revision: nonce(),
          scopeRevision: changedScope ? nonce() : prior!.value.scopeRevision,
          credentialRevision: capture ? nonce() : prior!.value.credentialRevision,
          credentialRef: capture ? nonce() : prior!.value.credentialRef,
          settings,
          secret,
        })
        const ref = nonce()
        const raw = JSON.stringify(record)
        if (raw.length > 16 * 1024) throw new CatalogError('source-invalid')
        // Journal the new slot before writing it so interrupted provisioning can erase it on reopen.
        await this.#commit(this.#records, [ref], authorized)
        // The new Keychain record is immutable. The index switch is the durable commit point.
        await this.#backend.upsert(this.#service, ref, raw)
        const next = new Map(this.#records).set(record.id, { ref, value: metadataOf(record) })
        try {
          await this.#commit(next, prior ? [prior.ref] : [], authorized)
        } catch (error) {
          // A backend failure may occur after its write. Never delete a possibly committed record.
          this.#closed = true
          this.#revoke()
          throw error
        }
        await this.#cleanup()
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
      await this.#cleanup()
      const prior = this.#records.get(id)
      if (!prior || prior.value.revision !== expectedRevision) throw new CatalogError('source-invalid')
      const next = new Map(this.#records)
      next.delete(id)
      await this.#commit(next, [prior.ref], authorized)
      await this.#cleanup()
    })
  }

  /** At most one fixed operation. No plugin-supplied adapter, URL, headers or credential lookup. */
  connection(id: string): DiscoveryConnection | undefined {
    const entry = this.#records.get(id)
    if (
      this.#closed || !entry || !entry.value.settings.discoveryEnabled || entry.value.settings.strategy.kind !== 'auto'
    ) return undefined
    const record = entry.value
    const current = () => !this.#closed && this.#records.get(id) === entry
    return Object.freeze({
      endpoint: record.settings.endpoint,
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
            operation: { origin: 'https://api.deepseek.com', method: 'GET', path: '/models' },
            current: () => current() && !signal.aborted,
            bearer: async () => {
              await this.#assertCurrent()
              const latest = await this.#readRecord(entry)
              return latest.secret
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
    if (await this.#backend.status(this.#service, 'index') === 'unset') {
      this.#index = JSON.stringify({ version: 1, entries: [], retired: [] })
      await this.#backend.upsert(this.#service, 'index', this.#index)
    } else this.#index = await this.#backend.read(this.#service, 'index')
    const index = object(JSON.parse(this.#index))
    if (
      !index || index.version !== 1 || Object.keys(index).length !== 3 || !Array.isArray(index.entries)
      || index.entries.length > 64
      || !Array.isArray(index.retired) || index.retired.length > 64 || !index.retired.every(opaqueProviderId)
    ) throw failure()
    this.#retired = [...index.retired]
    for (const value of index.entries) {
      const item = object(value)
      if (
        !item || Object.keys(item).length !== 2 || !opaqueProviderId(item.id) || !opaqueProviderId(item.ref)
        || this.#records.has(item.id)
      ) throw failure()
      const record = parseManagedProviderRecord(JSON.parse(await this.#backend.read(this.#service, item.ref)))
      if (record.id !== item.id) throw failure()
      if (this.#retired.includes(item.ref)) throw failure()
      this.#records.set(item.id, { ref: item.ref, value: metadataOf(record) })
    }
    await this.#cleanup()
  }

  async #readRecord(entry: StoredEntry): Promise<ManagedProviderRecord> {
    const latest = parseManagedProviderRecord(JSON.parse(await this.#backend.read(this.#service, entry.ref)))
    if (JSON.stringify(metadataOf(latest)) !== JSON.stringify(entry.value)) throw failure()
    return latest
  }

  async #cleanup(): Promise<void> {
    if (!this.#retired.length) return
    for (const ref of this.#retired) await this.#backend.remove(this.#service, ref)
    await this.#commit(this.#records, [])
  }

  async #assertCurrent(): Promise<void> {
    if (this.#closed) throw failure()
    const metadata = await lstat(this.#lock).catch(() => undefined)
    if (
      !metadata?.isDirectory() || metadata.dev !== this.#lockIdentity.dev || metadata.ino !== this.#lockIdentity.ino
      || await this.#backend.read(this.#service, 'index') !== this.#index
    ) {
      this.#closed = true
      this.#revoke()
      throw failure()
    }
    if (this.#closed) throw failure()
  }

  async #commit(
    next: Map<string, StoredEntry>,
    retired: string[],
    authorized: () => boolean = () => true,
  ): Promise<void> {
    await this.#assertCurrent()
    if (!authorized()) throw new CatalogError('permission')
    const index = JSON.stringify({
      version: 1,
      entries: [...next].map(([id, record]) => ({ id, ref: record.ref })),
      retired,
    })
    await this.#backend.upsert(this.#service, 'index', index)
    this.#index = index
    this.#records = next
    this.#retired = retired
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
