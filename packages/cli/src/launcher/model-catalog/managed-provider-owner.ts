import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureHomeConfig, type HomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../../config/home-config.js'
import {
  enabledHomeEnvironment,
  HOME_ENVIRONMENT_NAME,
  type HomeConfigEnvironmentVariable,
  parseHomeConfigEnvironmentVariables,
} from '../../config/home-config-environment.js'
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
import { acquireKernelOperationLock, KernelOperationBusyError } from '../kernel-operation-lock.js'
import { liveProcessStartedAt, recordedProcessStatus } from '../process-identity.js'
import { type PortableBundle, validatePortableBundle } from './portable-transfer-codec.js'

const nonce = () => randomBytes(32).toString('base64url')
// One 256,000-byte portable connection may duplicate 512 maximum-length IDs in strategy.ids.
// The final allowance covers the Host-generated record fields and a later 8 KB credential.
const MAX_MANAGED_PROVIDER_RECORD_CHARS = 256_000 + 512 * (512 + 3) + 16 * 1024
const failure = () => new CatalogError('credential-unavailable')
const lockBusy = () => new CatalogError('temporary')
const lockInvalid = () => new CatalogError('source-invalid')
const recordsSource = (records: readonly ManagedProviderRecord[]) => JSON.stringify(records)
const allocateEnvironmentName = (requested: string, used: ReadonlySet<string>): string => {
  if (!used.has(requested)) return requested
  for (let suffix = 1; suffix <= 128; suffix += 1) {
    const stem = requested.slice(0, Math.max(1, 127 - String(suffix).length))
    const candidate = `${stem}_${suffix}`
    if (!used.has(candidate)) return candidate
  }
  throw new CatalogError('source-invalid')
}
const assertRecordCapacity = (record: ManagedProviderRecord): void => {
  if (JSON.stringify(record).length > MAX_MANAGED_PROVIDER_RECORD_CHARS) throw new CatalogError('source-invalid')
}

interface OwnerOptions {
  readonly homeDir: string
  readonly profileId: string
  readonly appId?: string
  readonly fetcher?: DiscoveryFetch
  /** One-shot recovery for an exact pre-metadata lock after its known launcher exited. */
  readonly recoverLegacyLock?: { readonly exitedPid: number; readonly inode: number }
}

interface OwnerLockRecord {
  readonly version: 1
  readonly pid: number
  readonly processStartedAt: string
  readonly token: string
}

interface OwnerLockLease {
  readonly identity: { readonly dev: number; readonly ino: number }
  readonly token: string
  readonly release: () => Promise<void>
}

function parseOwnerLockRecord(source: string): OwnerLockRecord | undefined {
  try {
    const value = JSON.parse(source) as Partial<OwnerLockRecord>
    if (
      value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid! <= 0
      || typeof value.processStartedAt !== 'string' || value.processStartedAt === ''
      || typeof value.token !== 'string' || value.token === ''
    ) return undefined
    return value as OwnerLockRecord
  } catch {
    return undefined
  }
}

async function readOwnerLockRecord(lock: string): Promise<OwnerLockRecord | undefined> {
  const file = path.join(lock, 'owner.json')
  const metadata = await lstat(file).catch(() => undefined)
  if (
    !metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 4096 || (metadata.mode & 0o077) !== 0
    || process.getuid && metadata.uid !== process.getuid()
  ) return undefined
  return parseOwnerLockRecord(await readFile(file, 'utf8').catch(() => ''))
}

function legacyOwnerExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function reclaimOwnerLock(
  lock: string,
  expected: { readonly token?: string; readonly inode: number },
): Promise<void> {
  const quarantine = `${lock}.stale-${randomUUID()}`
  try {
    await rename(lock, quarantine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const metadata = await lstat(quarantine).catch(() => undefined)
  const record = await readOwnerLockRecord(quarantine)
  const matches = metadata?.isDirectory() === true && metadata.ino === expected.inode
    && (expected.token === undefined ? (await readdir(quarantine)).length === 0 : record?.token === expected.token)
  if (matches) {
    await rm(quarantine, { recursive: true, force: true })
    return
  }
  try {
    await rename(quarantine, lock)
  } catch (error) {
    throw new Error(`managed Provider lock changed during recovery; restore it from ${quarantine}`, { cause: error })
  }
  throw lockInvalid()
}

async function acquireOwnerLock(lock: string, recovery?: OwnerOptions['recoverLegacyLock']): Promise<OwnerLockLease> {
  let unlock: () => Promise<void>
  try {
    unlock = await acquireKernelOperationLock(`${lock}.mutex`)
  } catch (error) {
    if (error instanceof KernelOperationBusyError) throw lockBusy()
    throw lockInvalid()
  }
  try {
    const processStartedAt = liveProcessStartedAt(process.pid)
    if (processStartedAt === undefined) throw lockInvalid()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let created = false
      try {
        await mkdir(lock, { mode: 0o700 })
        created = true
        const record: OwnerLockRecord = { version: 1, pid: process.pid, processStartedAt, token: randomUUID() }
        await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify(record)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        })
        const identity = await lstat(lock)
        return { identity, token: record.token, release: unlock }
      } catch (error) {
        if (created) await rm(lock, { recursive: true, force: true })
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || created) throw lockInvalid()
        const metadata = await lstat(lock).catch(() => undefined)
        if (
          !metadata?.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
          || process.getuid && metadata.uid !== process.getuid()
        ) throw lockInvalid()
        const record = await readOwnerLockRecord(lock)
        if (record !== undefined) {
          if (recordedProcessStatus(record.pid, record.processStartedAt) !== 'dead') throw lockBusy()
          if (attempt > 0) throw lockBusy()
          await reclaimOwnerLock(lock, { token: record.token, inode: metadata.ino })
          continue
        }
        const entries = await readdir(lock)
        if (entries.length !== 0) throw lockInvalid()
        if (
          attempt > 0 || recovery === undefined || !Number.isSafeInteger(recovery.exitedPid)
          || recovery.exitedPid <= 0 || !Number.isSafeInteger(recovery.inode) || recovery.inode !== metadata.ino
          || !legacyOwnerExited(recovery.exitedPid)
        ) throw lockBusy()
        await reclaimOwnerLock(lock, { inode: recovery.inode })
      }
    }
    throw lockBusy()
  } catch (error) {
    await unlock()
    throw error
  }
}

/** Host composition only. Never register this object as a plugin context service or renderer global. */
export class ManagedProviderOwner {
  readonly #configPath: string
  readonly #appId: string
  readonly #profileId: string
  readonly #lock: string
  readonly #lockIdentity: { dev: number; ino: number }
  readonly #lockToken: string
  readonly #releaseLock: () => Promise<void>
  readonly #fetcher: DiscoveryFetch | undefined
  #records = new Map<string, ManagedProviderRecord>()
  #environmentEntries: readonly HomeConfigEnvironmentVariable[] = Object.freeze([])
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
    lease: OwnerLockLease,
    fetcher?: DiscoveryFetch,
  ) {
    this.#configPath = configPath
    this.#appId = appId
    this.#profileId = profileId
    this.#lock = lock
    this.#lockIdentity = lease.identity
    this.#lockToken = lease.token
    this.#releaseLock = lease.release
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
    const lease = await acquireOwnerLock(lock, options.recoverLegacyLock)
    const owner = new ManagedProviderOwner(
      configPath,
      options.appId ?? 'codex',
      options.profileId,
      lock,
      lease,
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
    return Object.freeze(
      [...this.#records.values()].map(record => managedProviderView(record, this.#credential(record) !== undefined)),
    )
  }

  environmentReference(id: string): string | undefined {
    return this.#records.get(id)?.environmentReference
  }

  portableEnvironment(id: string): {
    readonly name?: string
    readonly value?: string
    readonly placeholder: boolean
  } | undefined {
    const record = this.#records.get(id)
    if (record?.environmentReference !== undefined) return { name: record.environmentReference, placeholder: false }
    return record?.secret === undefined ? undefined : { value: record.secret, placeholder: true }
  }

  environmentEntries(): readonly HomeConfigEnvironmentVariable[] {
    return this.#environmentEntries
  }

  saveEnvironment(
    entries: readonly HomeConfigEnvironmentVariable[],
    authorized: () => boolean = () => true,
  ): Promise<void> {
    return this.#serial(async () => {
      if (!authorized()) throw new CatalogError('permission')
      const expectedEnvironment = JSON.stringify(this.#environmentEntries)
      await this.#assertCurrent()
      if (JSON.stringify(this.#environmentEntries) !== expectedEnvironment) throw new CatalogError('source-invalid')
      const environmentVariables = parseHomeConfigEnvironmentVariables(entries)
      const updated = await updateHomeConfigAtomic(current => {
        if (!authorized()) throw new CatalogError('permission')
        if (recordsSource(this.#profileRecords(current)) !== this.#source) throw new CatalogError('source-invalid')
        if (JSON.stringify(current.environmentVariables) !== expectedEnvironment) {
          throw new CatalogError('source-invalid')
        }
        return { ...current, environmentVariables }
      }, { configPath: this.#configPath })
      this.#acceptConfig(updated)
      this.#changed()
    })
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
    const credential = record === undefined ? undefined : this.#credential(record)
    if (!record || credential === undefined || record.settings.protocol !== 'responses' && !admittedResponses()) {
      throw new CatalogError('unsupported')
    }
    await this.#assertCurrent()
    if (
      this.#records.get(id) !== record || this.#credential(record) !== credential
      || record.settings.protocol !== 'responses' && !admittedResponses()
    ) {
      throw new CatalogError('cancelled')
    }
    const endpoint = new URL(record.settings.endpoint)
    return Object.freeze({
      value: Object.freeze({
        service: { pluginId: 'cordisx-host', serviceId: id, generation: record.scopeRevision },
        endpoint: {
          origin: endpoint.origin,
          apiPath: endpoint.pathname as `/${string}`,
          auth: { scheme: 'bearer' as const, token: credential },
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
          ...(capture || prior?.environmentReference === undefined
            ? {}
            : { environmentReference: prior.environmentReference }),
          ...(secret === undefined ? {} : { secret }),
          ...(prior?.importTransferId === undefined ? {} : {
            importTransferId: prior.importTransferId,
            importDigest: prior.importDigest,
          }),
        })
        assertRecordCapacity(record)
        const next = new Map(this.#records).set(record.id, record)
        await this.#commit(next, authorized)
        return managedProviderView(record, this.#credential(record) !== undefined)
      } finally {
        clearTimeout(timer)
        this.#leases.delete(abort)
        abort.abort()
      }
    })
  }

  preparePortableImport(bundle: PortableBundle): readonly {
    readonly sourceName: string
    readonly name: string
    readonly value: string
    readonly enabled: boolean
    readonly description?: string
    readonly generator?: HomeConfigEnvironmentVariable['generator']
  }[] {
    const parsed = validatePortableBundle(bundle)
    if (parsed.version === 1) return Object.freeze([])
    const used = new Set(this.#environmentEntries.map(entry => entry.name))
    return Object.freeze(parsed.environment.map(variable => {
      const name = allocateEnvironmentName(variable.name, used)
      used.add(name)
      return Object.freeze({
        sourceName: variable.name,
        name,
        value: variable.value ?? '',
        enabled: true,
        ...(variable.description === undefined ? {} : { description: variable.description }),
        ...(variable.generator === undefined ? {} : { generator: variable.generator }),
      })
    }))
  }

  /** Validates the whole bundle, then appends environment and Provider records in one atomic config write. */
  importPortable(
    bundle: PortableBundle,
    variablesOrAuthorized:
      | readonly {
        readonly sourceName: string
        readonly name: string
        readonly value: string
        readonly enabled: boolean
        readonly description?: string
        readonly generator?: HomeConfigEnvironmentVariable['generator']
      }[]
      | (() => boolean) = [],
    authorize: () => boolean = () => true,
  ): Promise<{
    readonly imported: number
    readonly skipped: number
    readonly bindingRefs: readonly string[]
  }> {
    const authorized = typeof variablesOrAuthorized === 'function' ? variablesOrAuthorized : authorize
    const requestedVariables = typeof variablesOrAuthorized === 'function' ? [] : variablesOrAuthorized
    return this.#serial(async () => {
      if (!authorized()) throw new CatalogError('permission')
      await this.#assertCurrent()
      const parsed = validatePortableBundle(bundle)
      const sourceVariables = parsed.version === 1 ? [] : parsed.environment
      const supplied = new Map(requestedVariables.map(variable => [variable.sourceName, variable]))
      if (
        supplied.size !== requestedVariables.length || supplied.size !== sourceVariables.length
        || sourceVariables.some(variable => !supplied.has(variable.name))
        || requestedVariables.some(variable =>
          !HOME_ENVIRONMENT_NAME.test(variable.sourceName) || !HOME_ENVIRONMENT_NAME.test(variable.name)
          || typeof variable.value !== 'string' || variable.value.length > 16_384 || variable.value.includes('\0')
          || typeof variable.enabled !== 'boolean'
          || variable.description !== undefined
            && (variable.description.length > 512 || variable.description.includes('\0'))
          || variable.generator !== undefined
            && (variable.generator.kind !== 'shell' || typeof variable.generator.script !== 'string'
              || variable.generator.script.length > 16_384 || variable.generator.script.includes('\0'))
        )
      ) throw new CatalogError('source-invalid')
      const next = new Map(this.#records)
      const identities = new Map(
        [...next.values()].flatMap(record =>
          record.importTransferId === undefined ? [] : [[record.importTransferId, record] as const]
        ),
      )
      let skipped = 0
      const bindingRefs: string[] = []
      const pending: Array<{ readonly connection: PortableBundle['connections'][number]; readonly recordId: string }> =
        []
      for (const connection of parsed.connections) {
        const digest = createHash('sha256').update(JSON.stringify(connection)).digest('hex')
        const prior = identities.get(connection.transferId)
        if (prior) {
          if (prior.importDigest !== digest) throw new CatalogError('source-invalid')
          skipped++
          continue
        }
        if (next.size >= 64) throw new CatalogError('source-invalid')
        const models = connection.models.map(model => ({
          id: model.id,
          label: model.label,
          ...(model.protocolCapabilities ? { protocolCapabilities: model.protocolCapabilities } : {}),
          ...(model.reasoningCapabilities ? { reasoningCapabilities: model.reasoningCapabilities } : {}),
        }))
        const settings = managedProviderSettings({
          title: connection.title,
          endpoint: connection.endpoint,
          protocol: connection.protocol,
          discoveryEnabled: false,
          strategy: { kind: 'manual', ids: models.map(model => model.id) },
          supplement: [],
          models,
        })
        const recordId = nonce()
        const record = parseManagedProviderRecord({
          id: recordId,
          revision: nonce(),
          scopeRevision: nonce(),
          credentialRevision: nonce(),
          credentialRef: nonce(),
          importTransferId: connection.transferId,
          importDigest: digest,
          ...(connection.environment === undefined ? {} : { environmentReference: connection.environment }),
          settings,
        })
        assertRecordCapacity(record)
        next.set(record.id, record)
        identities.set(connection.transferId, record)
        bindingRefs.push(record.id)
        pending.push({ connection, recordId })
      }
      if (bindingRefs.length > 0) {
        let committedRecords = next
        const updated = await updateHomeConfigAtomic(current => {
          if (!authorized()) throw new CatalogError('permission')
          if (recordsSource(this.#profileRecords(current)) !== this.#source) throw new CatalogError('source-invalid')
          const used = new Set(current.environmentVariables.map(entry => entry.name))
          const allocated = new Map<string, string>()
          const appended: HomeConfigEnvironmentVariable[] = []
          for (const source of sourceVariables) {
            if (!pending.some(item => item.connection.environment === source.name)) continue
            const requested = supplied.get(source.name)!
            const name = allocateEnvironmentName(requested.name, used)
            used.add(name)
            allocated.set(source.name, name)
            appended.push({
              name,
              value: requested.value,
              enabled: requested.enabled,
              ...(requested.description === undefined || requested.description === ''
                ? {}
                : { description: requested.description }),
              ...(requested.generator === undefined ? {} : { generator: requested.generator }),
            })
          }
          committedRecords = new Map(next)
          for (const item of pending) {
            if (item.connection.environment === undefined) continue
            const record = committedRecords.get(item.recordId)!
            committedRecords.set(
              item.recordId,
              parseManagedProviderRecord({
                ...record,
                environmentReference: allocated.get(item.connection.environment),
              }),
            )
          }
          const app = current.apps[this.#appId]!
          const profile = app.profiles[this.#profileId]!
          return {
            ...current,
            environmentVariables: [...current.environmentVariables, ...appended],
            apps: {
              ...current.apps,
              [this.#appId]: {
                ...app,
                profiles: {
                  ...app.profiles,
                  [this.#profileId]: { ...profile, managedProviders: [...committedRecords.values()] },
                },
              },
            },
          }
        }, { configPath: this.#configPath })
        this.#records = committedRecords
        this.#acceptConfig(updated)
        this.#changed()
      }
      return { imported: bindingRefs.length, skipped, bindingRefs: Object.freeze(bindingRefs) }
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
    const credential = record === undefined ? undefined : this.#credential(record)
    if (
      this.#closed || !record || credential === undefined || !record.settings.discoveryEnabled
      || record.settings.strategy.kind !== 'auto'
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
              const currentCredential = this.#credential(record)
              if (currentCredential === undefined) throw new CatalogError('credential-unavailable')
              return currentCredential
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
    const config = await loadHomeConfig(this.#configPath)
    const records = this.#profileRecords(config)
    this.#environmentEntries = config.environmentVariables
    this.#environment = enabledHomeEnvironment(this.#environmentEntries)
    this.#source = recordsSource(records)
    this.#records = new Map(records.map(record => [record.id, record]))
  }

  async #assertCurrent(): Promise<void> {
    if (this.#closed) throw failure()
    const metadata = await lstat(this.#lock).catch(() => undefined)
    const record = await readOwnerLockRecord(this.#lock)
    if (
      !metadata?.isDirectory() || metadata.dev !== this.#lockIdentity.dev || metadata.ino !== this.#lockIdentity.ino
      || record?.token !== this.#lockToken
    ) {
      this.#closed = true
      this.#revoke()
      throw failure()
    }
    const config = await loadHomeConfig(this.#configPath)
    const source = recordsSource(this.#profileRecords(config))
    if (source !== this.#source) {
      this.#closed = true
      this.#revoke()
      throw failure()
    }
    this.#environmentEntries = config.environmentVariables
    this.#environment = enabledHomeEnvironment(this.#environmentEntries)
    if (this.#closed) throw failure()
  }

  #profileRecords(config: HomeConfig): readonly ManagedProviderRecord[] {
    const profile = config.apps[this.#appId]?.profiles[this.#profileId]
    if (!profile) throw new CatalogError('source-invalid')
    return profile.managedProviders ?? []
  }

  #environment: Readonly<Record<string, string>> = Object.freeze({})

  #credential(record: ManagedProviderRecord): string | undefined {
    const value = record.environmentReference === undefined
      ? record.secret
      : this.#environment[record.environmentReference]
    return value === '' ? undefined : value
  }

  #acceptConfig(config: HomeConfig): void {
    this.#source = recordsSource(this.#profileRecords(config))
    this.#environmentEntries = config.environmentVariables
    this.#environment = enabledHomeEnvironment(this.#environmentEntries)
  }

  #changed(): void {
    this.#revoke()
    if (this.#closed) return
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch { /* Reader isolation. */ }
    }
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
    this.#acceptConfig(updated)
    this.#records = next
    this.#changed()
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
      try {
        const metadata = await lstat(this.#lock).catch(() => undefined)
        const record = await readOwnerLockRecord(this.#lock)
        if (
          metadata?.dev === this.#lockIdentity.dev && metadata.ino === this.#lockIdentity.ino
          && record?.token === this.#lockToken
        ) await rm(this.#lock, { recursive: true })
      } finally {
        await this.#releaseLock()
      }
    })()
    return this.#closePromise
  }
}
