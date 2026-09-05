import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats, unwatchFile, watchFile } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { type HomeConfigMarketplaceTrustSource, loadHomeConfig } from '../config/home-config.js'
import { canonicalPluginSource, marketplacePluginIdentity, parseMarketplaceFeed } from '../renderer/marketplace.js'
import type { MarketplaceCertifiedPermissionProjectionV1 } from '../renderer/marketplace-trust.js'
import { fetchMarketplaceFeed, type MarketplaceFetchResult } from './marketplace.js'

export type { MarketplaceCertifiedPermissionProjectionV1 } from '../renderer/marketplace-trust.js'

const STATE_CONTRACT = 'cordisx.launcher-marketplace-certified-authority/v1'
const MAX_CONFIGURED_SOURCES = 8
const MAX_TRACKED_SOURCES = 32
const MAX_FEED_BYTES = 2 * 1024 * 1024
const MAX_STATE_BYTES = 70 * 1024 * 1024
const DEFAULT_FETCH_CONCURRENCY = 2
const MAX_FETCH_CONCURRENCY = 4
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAX_REQUEST_TIMEOUT_MS = 30_000
const CONFIG_WATCH_INTERVAL_MS = 250
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const INTEGRITY = /^sha256:[a-f0-9]{64}$/

export interface MarketplaceCertifiedArtifactIdentity {
  readonly source: string
  readonly pluginId: string
  readonly version: string
  readonly integrity: `sha256:${string}`
}

export interface LauncherMarketplaceCertifiedSnapshot {
  readonly revision: number
  readonly projections: readonly MarketplaceCertifiedPermissionProjectionV1[]
}

export interface LauncherMarketplaceCertifiedLookup {
  readonly revision: number
  readonly projection?: MarketplaceCertifiedPermissionProjectionV1
}

export type LauncherMarketplaceFeedFetcher = (
  url: string,
  signal: AbortSignal,
) => Promise<MarketplaceFetchResult>

export interface LauncherMarketplaceCertifiedAuthorityOptions {
  readonly homeDir: string
  readonly configPath: string
  readonly profileId: string
  readonly fetcher?: LauncherMarketplaceFeedFetcher
  readonly now?: () => number
  readonly requestTimeoutMs?: number
  readonly maxConcurrentFetches?: number
  /** Tests and one-shot maintenance tools may opt out; production watches by default. */
  readonly watchConfig?: boolean
}

interface PersistedSourceState {
  readonly enabled: boolean
  readonly generatedAt?: string
  readonly digest?: `sha256:${string}`
  readonly feedText?: string
  readonly requiresNewer: boolean
}

interface PersistedAuthorityState {
  readonly contract: typeof STATE_CONTRACT
  readonly revision: number
  readonly projectionDigest: `sha256:${string}`
  readonly sources: Readonly<Record<string, PersistedSourceState>>
}

interface FetchOutcome {
  readonly source: HomeConfigMarketplaceTrustSource
  readonly result?: MarketplaceFetchResult
  readonly error?: unknown
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).find(key => !keys.has(key))
  if (unknown !== undefined) throw new Error(`${label}.${unknown} is unsupported`)
}

function canonicalTrustRoot(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) throw new Error(`${label} is invalid`)
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) throw new Error(`${label} must be an HTTPS URL without credentials, query, or fragment`)
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.href !== value) throw new Error(`${label} must be canonical`)
  return value
}

function parseExactIdentity(value: unknown): MarketplaceCertifiedArtifactIdentity {
  const identity = object(value, 'Marketplace Certified artifact identity')
  exactKeys(identity, ['source', 'pluginId', 'version', 'integrity'], 'Marketplace Certified artifact identity')
  if (typeof identity.source !== 'string') throw new Error('Marketplace Certified artifact identity.source is invalid')
  const source = canonicalPluginSource(identity.source)
  if (source !== identity.source) throw new Error('Marketplace Certified artifact identity.source must be canonical')
  if (typeof identity.pluginId !== 'string' || !PLUGIN_ID.test(identity.pluginId)) {
    throw new Error('Marketplace Certified artifact identity.pluginId is invalid')
  }
  if (typeof identity.version !== 'string' || !SEMVER.test(identity.version)) {
    throw new Error('Marketplace Certified artifact identity.version is invalid')
  }
  if (typeof identity.integrity !== 'string' || !INTEGRITY.test(identity.integrity)) {
    throw new Error('Marketplace Certified artifact identity.integrity is invalid')
  }
  return {
    source,
    pluginId: identity.pluginId,
    version: identity.version,
    integrity: identity.integrity as `sha256:${string}`,
  }
}

function identityKey(value: MarketplaceCertifiedArtifactIdentity | MarketplaceCertifiedPermissionProjectionV1): string {
  return [value.source, value.pluginId, value.version, value.integrity].join('\u0000')
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function projectionDigest(projections: readonly MarketplaceCertifiedPermissionProjectionV1[]): `sha256:${string}` {
  return sha256(JSON.stringify(projections.map(value => [identityKey(value), value.fingerprint, value.revision])))
}

function initialState(): PersistedAuthorityState {
  return { contract: STATE_CONTRACT, revision: 0, projectionDigest: projectionDigest([]), sources: {} }
}

function withoutFeed(
  source: PersistedSourceState,
  enabled: boolean,
  requiresNewer = source.requiresNewer,
): PersistedSourceState {
  return {
    enabled,
    ...(source.generatedAt === undefined ? {} : { generatedAt: source.generatedAt }),
    ...(source.digest === undefined ? {} : { digest: source.digest }),
    requiresNewer,
  }
}

function strictNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function strictInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`)
  }
  return value
}

function parsePersistedState(value: unknown): PersistedAuthorityState {
  const state = object(value, 'Marketplace Certified authority state')
  exactKeys(state, ['contract', 'revision', 'projectionDigest', 'sources'], 'Marketplace Certified authority state')
  if (state.contract !== STATE_CONTRACT) {
    throw new Error('Marketplace Certified authority state contract is unsupported')
  }
  if (typeof state.projectionDigest !== 'string' || !INTEGRITY.test(state.projectionDigest)) {
    throw new Error('Marketplace Certified authority state projectionDigest is invalid')
  }
  const sourceValues = object(state.sources, 'Marketplace Certified authority state.sources')
  if (Object.keys(sourceValues).length > MAX_TRACKED_SOURCES) {
    throw new Error('Marketplace Certified authority tracks too many sources')
  }
  const sources: Record<string, PersistedSourceState> = Object.create(null) as Record<string, PersistedSourceState>
  for (const [sourceUrl, rawSource] of Object.entries(sourceValues)) {
    canonicalTrustRoot(sourceUrl, 'Marketplace Certified authority source key')
    const source = object(rawSource, `Marketplace Certified authority source ${sourceUrl}`)
    exactKeys(
      source,
      ['enabled', 'generatedAt', 'digest', 'feedText', 'requiresNewer'],
      `Marketplace Certified authority source ${sourceUrl}`,
    )
    if (typeof source.enabled !== 'boolean' || typeof source.requiresNewer !== 'boolean') {
      throw new Error(`Marketplace Certified authority source ${sourceUrl} flags are invalid`)
    }
    const generatedAt = source.generatedAt === undefined
      ? undefined
      : strictInstant(source.generatedAt, `Marketplace Certified authority source ${sourceUrl}.generatedAt`)
    const digest = source.digest
    if (digest !== undefined && (typeof digest !== 'string' || !INTEGRITY.test(digest))) {
      throw new Error(`Marketplace Certified authority source ${sourceUrl}.digest is invalid`)
    }
    if ((generatedAt === undefined) !== (digest === undefined)) {
      throw new Error(`Marketplace Certified authority source ${sourceUrl} watermark is incomplete`)
    }
    const feedText = source.feedText
    if (feedText !== undefined) {
      if (typeof feedText !== 'string' || Buffer.byteLength(feedText) > MAX_FEED_BYTES) {
        throw new Error(`Marketplace Certified authority source ${sourceUrl}.feedText is invalid`)
      }
      if (digest === undefined || sha256(feedText) !== digest) {
        throw new Error(`Marketplace Certified authority source ${sourceUrl}.feedText digest mismatch`)
      }
      if (!source.enabled) {
        throw new Error(`Marketplace Certified authority source ${sourceUrl}.feedText must be absent while disabled`)
      }
      const feed = parseTrustedFeed(feedText, sourceUrl, generatedAt ?? '')
      if (feed.trust?.generatedAt !== generatedAt) {
        throw new Error(`Marketplace Certified authority source ${sourceUrl}.generatedAt does not match feed`)
      }
    }
    sources[sourceUrl] = {
      enabled: source.enabled,
      ...(generatedAt === undefined ? {} : { generatedAt }),
      ...(digest === undefined ? {} : { digest: digest as `sha256:${string}` }),
      ...(feedText === undefined ? {} : { feedText }),
      requiresNewer: source.requiresNewer,
    }
  }
  return {
    contract: STATE_CONTRACT,
    revision: strictNonNegativeInteger(state.revision, 'Marketplace Certified authority state.revision'),
    projectionDigest: state.projectionDigest as `sha256:${string}`,
    sources,
  }
}

function parseTrustedFeed(text: string, root: string, now: string): ReturnType<typeof parseMarketplaceFeed> {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error('Marketplace trust feed is not valid JSON', { cause: error })
  }
  const feed = parseMarketplaceFeed(value, { feedUrl: root, trustedRoots: [root], now })
  if (feed.schemaVersion < 3 || feed.trust?.trusted !== true) {
    throw new Error('Marketplace trust feed is not a trusted v3+ feed')
  }
  return feed
}

function feedGeneratedAt(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const generatedAt = (value as Record<string, unknown>).generatedAt
    return typeof generatedAt === 'string' && generatedAt.length <= 64 && Number.isFinite(Date.parse(generatedAt))
      ? generatedAt
      : undefined
  } catch {
    return undefined
  }
}

function projectionsFromSources(
  sources: Readonly<Record<string, PersistedSourceState>>,
  now: number,
): readonly MarketplaceCertifiedPermissionProjectionV1[] {
  const candidates = new Map<string, MarketplaceCertifiedPermissionProjectionV1[]>()
  for (const [root, source] of Object.entries(sources)) {
    if (!source.enabled || source.feedText === undefined || source.generatedAt === undefined) continue
    const feed = parseTrustedFeed(source.feedText, root, source.generatedAt)
    for (const plugin of feed.plugins) {
      const projection = feed.trust?.byPluginIdentity.get(marketplacePluginIdentity(plugin.source, plugin.id))
        ?.certifiedPermission
      if (projection === undefined || Date.parse(projection.expiresAt) <= now) continue
      const key = identityKey(projection)
      candidates.set(key, [...(candidates.get(key) ?? []), projection])
    }
  }
  return Object.freeze(
    [...candidates.entries()]
      .filter(([, values]) => values.length === 1)
      .map(([, values]) => values[0] as MarketplaceCertifiedPermissionProjectionV1)
      .sort((left, right) => identityKey(left).localeCompare(identityKey(right))),
  )
}

function normalizedLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`)
  }
  return result
}

async function ensureRealPrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Marketplace Certified authority directory must be a real directory: ${directory}`)
  }
  if (process.platform !== 'win32') await chmod(directory, 0o700)
}

async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Launcher-private Certified authority. No renderer payload, bridge, global,
 * localStorage record, Official designation, or plugin manifest is accepted.
 */
export class LauncherMarketplaceCertifiedAuthority {
  private readonly stateFile: string
  private readonly fetcher: LauncherMarketplaceFeedFetcher
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly listeners = new Set<(revision: number) => void>()
  private state: PersistedAuthorityState = initialState()
  private projections: readonly MarketplaceCertifiedPermissionProjectionV1[] = Object.freeze([])
  private operationTail: Promise<void> = Promise.resolve()
  private refreshInFlight: Promise<LauncherMarketplaceCertifiedSnapshot> | undefined
  private expiryTimer: NodeJS.Timeout | undefined
  private disposed = false
  private readonly configWatchListener = (_current: Stats, _previous: Stats): void => {
    void this.refresh().catch(() => undefined)
  }

  private constructor(private readonly options: LauncherMarketplaceCertifiedAuthorityOptions) {
    this.fetcher = options.fetcher ?? fetchMarketplaceFeed
    this.now = options.now ?? Date.now
    this.timeoutMs = normalizedLimit(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    this.concurrency = normalizedLimit(
      options.maxConcurrentFetches,
      DEFAULT_FETCH_CONCURRENCY,
      MAX_FETCH_CONCURRENCY,
      'maxConcurrentFetches',
    )
    this.stateFile = path.join(options.homeDir, 'state', 'marketplace-certified', `${options.profileId}.v1.json`)
  }

  static async open(
    options: LauncherMarketplaceCertifiedAuthorityOptions,
  ): Promise<LauncherMarketplaceCertifiedAuthority> {
    if (!path.isAbsolute(options.homeDir) || !path.isAbsolute(options.configPath)) {
      throw new Error('Marketplace Certified authority paths must be absolute')
    }
    const homeDir = path.resolve(options.homeDir)
    const configPath = path.resolve(options.configPath)
    if (path.dirname(configPath) !== homeDir) {
      throw new Error('Marketplace Certified authority configPath must be inside homeDir')
    }
    if (!PROFILE_ID.test(options.profileId)) throw new Error('Marketplace Certified authority profileId is invalid')
    const home = await lstat(homeDir)
    if (home.isSymbolicLink() || !home.isDirectory()) {
      throw new Error('Marketplace Certified authority homeDir must be a real directory')
    }
    const stateDirectory = path.join(homeDir, 'state')
    await ensureRealPrivateDirectory(stateDirectory)
    await ensureRealPrivateDirectory(path.join(stateDirectory, 'marketplace-certified'))
    const authority = new LauncherMarketplaceCertifiedAuthority({ ...options, homeDir, configPath })
    authority.state = await authority.readOrCreateState()
    authority.projections = projectionsFromSources(authority.state.sources, authority.now())
    await authority.synchronizeProjectionClock(false)
    await authority.refresh()
    if (options.watchConfig !== false) {
      watchFile(configPath, { persistent: false, interval: CONFIG_WATCH_INTERVAL_MS }, authority.configWatchListener)
    }
    return authority
  }

  /** Re-fetch enabled Host-configured roots and atomically advance the private authority state. */
  refresh(): Promise<LauncherMarketplaceCertifiedSnapshot> {
    if (this.disposed) return Promise.reject(new Error('Marketplace Certified authority is disposed'))
    if (this.refreshInFlight !== undefined) return this.refreshInFlight
    const operation = this.enqueue(async () => await this.refreshNow())
    let tracked: Promise<LauncherMarketplaceCertifiedSnapshot>
    tracked = operation.finally(() => {
      if (this.refreshInFlight === tracked) this.refreshInFlight = undefined
    })
    this.refreshInFlight = tracked
    return tracked
  }

  /** Exact lookup always refreshes Host-private source/config state first. */
  async lookup(value: unknown): Promise<LauncherMarketplaceCertifiedLookup> {
    const identity = parseExactIdentity(value)
    const snapshot = await this.refresh()
    const projection = snapshot.projections.find(candidate => identityKey(candidate) === identityKey(identity))
    return { revision: snapshot.revision, ...(projection === undefined ? {} : { projection }) }
  }

  /** Current immutable projection; consumers must still enforce expiresAt locally. */
  snapshot(): LauncherMarketplaceCertifiedSnapshot {
    const now = this.now()
    return Object.freeze({
      revision: this.state.revision,
      projections: Object.freeze(this.projections.filter(projection => Date.parse(projection.expiresAt) > now)),
    })
  }

  /** Revision-only invalidation. Consumers re-read snapshot()/lookup(); no payload is retained. */
  subscribe(listener: (revision: number) => void): () => void {
    if (this.disposed) throw new Error('Marketplace Certified authority is disposed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    unwatchFile(this.options.configPath, this.configWatchListener)
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    this.listeners.clear()
    await this.operationTail.catch(() => undefined)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail.catch(() => undefined)
    const current = previous.then(operation)
    this.operationTail = current.then(() => undefined, () => undefined)
    return current
  }

  private async refreshNow(): Promise<LauncherMarketplaceCertifiedSnapshot> {
    let configured: readonly HomeConfigMarketplaceTrustSource[]
    try {
      const config = await loadHomeConfig(this.options.configPath)
      configured = config.marketplaceTrustSources
    } catch {
      await this.commitDisabledSources()
      return this.snapshot()
    }
    if (configured.length > MAX_CONFIGURED_SOURCES) {
      throw new Error('Marketplace Certified authority has too many configured sources')
    }
    const configuredUrls = new Set(configured.map(source => source.url))
    const nextSources: Record<string, PersistedSourceState> = Object.create(null) as Record<
      string,
      PersistedSourceState
    >
    for (const [url, source] of Object.entries(this.state.sources)) {
      const configuredSource = configured.find(candidate => candidate.url === url)
      nextSources[url] = configuredSource?.enabled === true
        ? { ...source, enabled: true }
        : withoutFeed(source, false)
    }
    for (const source of configured) {
      canonicalTrustRoot(source.url, 'Marketplace Certified trust source')
      if (!Object.hasOwn(nextSources, source.url)) {
        if (Object.keys(nextSources).length >= MAX_TRACKED_SOURCES) {
          throw new Error('Marketplace Certified authority source history is full')
        }
        nextSources[source.url] = { enabled: source.enabled, requiresNewer: false }
      }
    }
    for (const url of Object.keys(nextSources)) {
      if (!configuredUrls.has(url)) nextSources[url] = withoutFeed(nextSources[url] as PersistedSourceState, false)
    }
    const enabled = configured.filter(source => source.enabled)
    const outcomes = await this.fetchBounded(enabled)
    for (const outcome of outcomes) {
      const previous = nextSources[outcome.source.url] as PersistedSourceState
      if (outcome.result === undefined || outcome.error !== undefined) continue
      nextSources[outcome.source.url] = this.acceptFetch(outcome.source.url, previous, outcome.result)
    }
    await this.commitSources(nextSources)
    return this.snapshot()
  }

  private async commitDisabledSources(): Promise<void> {
    const disabled: Record<string, PersistedSourceState> = Object.create(null) as Record<string, PersistedSourceState>
    for (const [url, source] of Object.entries(this.state.sources)) {
      disabled[url] = withoutFeed(source, false)
    }
    await this.commitSources(disabled)
  }

  private acceptFetch(
    root: string,
    previous: PersistedSourceState,
    result: MarketplaceFetchResult,
  ): PersistedSourceState {
    if (result.status < 200 || result.status >= 300) return previous
    const invalid = (): PersistedSourceState => withoutFeed(previous, true, true)
    if (result.url !== root || Buffer.byteLength(result.text) > MAX_FEED_BYTES) return invalid()
    const digest = sha256(result.text)
    let feed: ReturnType<typeof parseMarketplaceFeed>
    try {
      const parseAt = feedGeneratedAt(result.text)
      if (parseAt === undefined) return invalid()
      feed = parseTrustedFeed(result.text, root, parseAt)
    } catch {
      return invalid()
    }
    const generatedAt = feed.trust?.generatedAt
    if (generatedAt === undefined) return invalid()
    if (previous.generatedAt !== undefined) {
      const order = Date.parse(generatedAt) - Date.parse(previous.generatedAt)
      if (order < 0 || (order === 0 && previous.requiresNewer)) return previous
      if (order === 0 && previous.digest !== digest) {
        return withoutFeed(previous, true, true)
      }
    }
    return { enabled: true, generatedAt, digest, feedText: result.text, requiresNewer: false }
  }

  private async fetchBounded(sources: readonly HomeConfigMarketplaceTrustSource[]): Promise<readonly FetchOutcome[]> {
    const outcomes: FetchOutcome[] = new Array(sources.length)
    let index = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const current = index
        index += 1
        const source = sources[current]
        if (source === undefined) return
        try {
          outcomes[current] = { source, result: await this.fetchWithTimeout(source.url) }
        } catch (error) {
          outcomes[current] = { source, error }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, sources.length) }, worker))
    return outcomes
  }

  private async fetchWithTimeout(url: string): Promise<MarketplaceFetchResult> {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Marketplace Certified trust feed request timed out'))
      }, this.timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([this.fetcher(url, controller.signal), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async commitSources(sources: Readonly<Record<string, PersistedSourceState>>): Promise<void> {
    const projections = projectionsFromSources(sources, this.now())
    const nextProjectionDigest = projectionDigest(projections)
    const sourceChanged = JSON.stringify(sources) !== JSON.stringify(this.state.sources)
    if (!sourceChanged && nextProjectionDigest === this.state.projectionDigest) {
      this.projections = projections
      this.scheduleExpiry()
      return
    }
    const next: PersistedAuthorityState = {
      contract: STATE_CONTRACT,
      revision: this.state.revision + 1,
      projectionDigest: nextProjectionDigest,
      sources,
    }
    await this.writeState(next)
    this.state = next
    this.projections = projections
    this.scheduleExpiry()
    this.notify()
  }

  private async synchronizeProjectionClock(notify: boolean): Promise<void> {
    const projections = projectionsFromSources(this.state.sources, this.now())
    const digest = projectionDigest(projections)
    if (digest === this.state.projectionDigest) {
      this.projections = projections
      this.scheduleExpiry()
      return
    }
    const next = { ...this.state, revision: this.state.revision + 1, projectionDigest: digest }
    await this.writeState(next)
    this.state = next
    this.projections = projections
    this.scheduleExpiry()
    if (notify) this.notify()
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    if (this.disposed || this.projections.length === 0) return
    const expiresAt = Math.min(...this.projections.map(projection => Date.parse(projection.expiresAt)))
    const delay = Math.max(1, Math.min(2_147_483_647, expiresAt - this.now()))
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined
      if (this.disposed) return
      void this.enqueue(async () => await this.synchronizeProjectionClock(true)).catch(() => undefined)
    }, delay)
    this.expiryTimer.unref?.()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state.revision)
      } catch {
        // One Host consumer must not suppress revocation invalidation for others.
      }
    }
  }

  private async readOrCreateState(): Promise<PersistedAuthorityState> {
    try {
      return await this.readState()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const state = initialState()
      await this.writeState(state)
      return state
    }
  }

  private async readState(): Promise<PersistedAuthorityState> {
    const pathStat = await lstat(this.stateFile)
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('Marketplace Certified authority state must be a regular file')
    }
    if (pathStat.size > MAX_STATE_BYTES) throw new Error('Marketplace Certified authority state is too large')
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(this.stateFile, constants.O_RDONLY | noFollow)
    try {
      const openedStat = await handle.stat()
      if (!openedStat.isFile() || pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
        throw new Error('Marketplace Certified authority state changed while being opened')
      }
      const text = await handle.readFile('utf8')
      return parsePersistedState(JSON.parse(text) as unknown)
    } finally {
      await handle.close()
    }
  }

  private async writeState(state: PersistedAuthorityState): Promise<void> {
    const directory = path.dirname(this.stateFile)
    const temporary = path.join(directory, `.${path.basename(this.stateFile)}.${process.pid}.${randomUUID()}.tmp`)
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    let published = false
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      try {
        const target = await lstat(this.stateFile)
        if (target.isSymbolicLink() || !target.isFile()) {
          throw new Error('refusing to replace non-regular Marketplace Certified authority state')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(temporary, this.stateFile)
      published = true
      if (process.platform !== 'win32') await chmod(this.stateFile, 0o600)
      await syncDirectory(directory)
    } finally {
      await handle.close().catch(() => undefined)
      if (!published) await unlink(temporary).catch(() => undefined)
    }
  }
}
