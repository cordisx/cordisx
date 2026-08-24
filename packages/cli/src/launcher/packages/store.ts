import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PackageStoreState } from './types.js'
import { PackageLifecycleError, PackageStoreConflictError } from './types.js'

interface MutablePackageStoreState {
  contract: 'cordisx.launcher-package-store/v1'
  schemaVersion: 1
  revision: number
  packages: Record<string, PackageStoreState['packages'][string]>
  profiles: Record<string, PackageStoreState['profiles'][string]>
  transactions: Record<string, PackageStoreState['transactions'][string]>
}

export type PackageStoreFaultPoint = 'after-temporary-sync' | 'before-rename' | 'after-rename'

export interface JsonPackageStoreOptions {
  readonly lockTimeoutMs?: number
  readonly lockRetryMs?: number
  readonly lockStaleMs?: number
  readonly fault?: (point: PackageStoreFaultPoint) => void | Promise<void>
}

const DEFAULT_LOCK_TIMEOUT_MS = 2_000
const DEFAULT_LOCK_RETRY_MS = 25
const DEFAULT_LOCK_STALE_MS = 30_000

function initialState(): MutablePackageStoreState {
  return {
    contract: 'cordisx.launcher-package-store/v1',
    schemaVersion: 1,
    revision: 0,
    packages: Object.create(null) as MutablePackageStoreState['packages'],
    profiles: Object.create(null) as MutablePackageStoreState['profiles'],
    transactions: Object.create(null) as MutablePackageStoreState['transactions'],
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PackageLifecycleError('invalid-package-store', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function validateState(value: unknown): MutablePackageStoreState {
  const state = object(value, 'package store')
  if (state.contract !== 'cordisx.launcher-package-store/v1' || state.schemaVersion !== 1) {
    throw new PackageLifecycleError('unsupported-package-store', 'package store contract is unsupported')
  }
  if (!Number.isInteger(state.revision) || (state.revision as number) < 0) {
    throw new PackageLifecycleError('invalid-package-store', 'package store revision must be a non-negative integer')
  }
  const packages = object(state.packages, 'package store packages')
  const profiles = object(state.profiles, 'package store profiles')
  const transactions = object(state.transactions, 'package store transactions')
  for (const [key, raw] of Object.entries(packages)) {
    const record = object(raw, `package ${key}`)
    const identity = object(record.identity, `package ${key} identity`)
    if (typeof identity.pluginId !== 'string' || typeof identity.version !== 'string'
      || typeof identity.integrity !== 'string' || typeof record.objectDirectory !== 'string'
      || !Array.isArray(record.sources) || typeof record.createdAt !== 'string') {
      throw new PackageLifecycleError('invalid-package-store', `package ${key} is malformed`)
    }
  }
  for (const [profileId, raw] of Object.entries(profiles)) {
    const profile = object(raw, `profile ${profileId}`)
    if (typeof profile.runtimeGeneration !== 'string') {
      throw new PackageLifecycleError('invalid-package-store', `profile ${profileId} runtime generation is malformed`)
    }
    object(profile.plugins, `profile ${profileId} plugins`)
  }
  for (const [transactionId, raw] of Object.entries(transactions)) {
    const transaction = object(raw, `transaction ${transactionId}`)
    if (transaction.transactionId !== transactionId || typeof transaction.status !== 'string'
      || typeof transaction.profileId !== 'string' || typeof transaction.candidateFingerprint !== 'string') {
      throw new PackageLifecycleError('invalid-package-store', `transaction ${transactionId} is malformed`)
    }
  }
  return structuredClone(state) as unknown as MutablePackageStoreState
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`)
  return value
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const metadata = await lstat(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PackageLifecycleError('invalid-package-store-root', `package store root must be a real directory: ${directory}`)
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new PackageLifecycleError('insecure-package-store-root', `package store root must be private (0700): ${directory}`)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY)
  try {
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EPERM') throw error
  } finally {
    await handle.close()
  }
}

export class JsonPackageStore {
  readonly #root: string
  readonly #file: string
  readonly #options: JsonPackageStoreOptions
  #state: MutablePackageStoreState
  #tail: Promise<void> = Promise.resolve()

  private constructor(root: string, state: MutablePackageStoreState, options: JsonPackageStoreOptions) {
    this.#root = root
    this.#file = path.join(root, 'state.v1.json')
    this.#state = state
    this.#options = options
  }

  static async open(root: string, options: JsonPackageStoreOptions = {}): Promise<JsonPackageStore> {
    const absoluteRoot = path.resolve(root)
    await ensurePrivateDirectory(absoluteRoot)
    const file = path.join(absoluteRoot, 'state.v1.json')
    let state: MutablePackageStoreState
    try {
      const metadata = await lstat(file)
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new PackageLifecycleError('invalid-package-store-file', 'package store state must be a regular file')
      }
      state = validateState(JSON.parse(await readFile(file, 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = initialState()
      const store = new JsonPackageStore(absoluteRoot, state, options)
      await store.#persist(state)
      return store
    }
    if (process.platform !== 'win32') await chmod(file, 0o600)
    return new JsonPackageStore(absoluteRoot, state, options)
  }

  get root(): string {
    return this.#root
  }

  snapshot(): PackageStoreState {
    return structuredClone(this.#state) as PackageStoreState
  }

  async transaction<T>(
    expectedRevision: number,
    mutate: (draft: MutablePackageStoreState) => T | Promise<T>,
  ): Promise<{ readonly value: T; readonly state: PackageStoreState }> {
    let result!: { readonly value: T; readonly state: PackageStoreState }
    let failure: unknown
    const previous = this.#tail
    this.#tail = previous.then(async () => {
      const lock = await this.#acquireLock()
      try {
        const current = await this.#readCurrent()
        if (current.revision !== expectedRevision) throw new PackageStoreConflictError(current.revision)
        const draft = structuredClone(current)
        const value = await mutate(draft)
        draft.revision = current.revision + 1
        const validated = validateState(draft)
        await this.#persist(validated)
        this.#state = validated
        result = { value, state: this.snapshot() }
      } catch (error) {
        failure = error
      } finally {
        await lock.release()
      }
    })
    await this.#tail
    if (failure !== undefined) throw failure
    return result
  }

  async refresh(): Promise<PackageStoreState> {
    const current = await this.#readCurrent()
    this.#state = current
    return this.snapshot()
  }

  async #readCurrent(): Promise<MutablePackageStoreState> {
    const metadata = await lstat(this.#file)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PackageLifecycleError('invalid-package-store-file', 'package store state must be a regular file')
    }
    return validateState(JSON.parse(await readFile(this.#file, 'utf8')) as unknown)
  }

  async #acquireLock(): Promise<{ readonly release: () => Promise<void> }> {
    const lockPath = `${this.#file}.lock`
    const timeoutMs = positiveDuration(this.#options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, 'lockTimeoutMs')
    const retryMs = positiveDuration(this.#options.lockRetryMs, DEFAULT_LOCK_RETRY_MS, 'lockRetryMs')
    const staleMs = positiveDuration(this.#options.lockStaleMs, DEFAULT_LOCK_STALE_MS, 'lockStaleMs')
    const startedAt = Date.now()
    for (;;) {
      try {
        const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
        await handle.sync()
        let released = false
        return {
          release: async () => {
            if (released) return
            released = true
            await handle.close()
            await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
            })
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const ageMs = Math.max(0, Date.now() - (await stat(lockPath)).mtimeMs)
          if (ageMs >= staleMs) throw new PackageLifecycleError('stale-package-store-lock', `package store lock appears stale: ${lockPath}`)
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw statError
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new PackageLifecycleError('package-store-lock-timeout', `timed out waiting for package store lock: ${lockPath}`)
        }
        await new Promise(resolve => setTimeout(resolve, retryMs))
      }
    }
  }

  async #persist(state: MutablePackageStoreState): Promise<void> {
    const temporary = path.join(this.#root, `.state.v1.json.${process.pid}.${randomUUID()}.tmp`)
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    let renamed = false
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      await this.#options.fault?.('after-temporary-sync')
      try {
        const target = await lstat(this.#file)
        if (target.isSymbolicLink() || !target.isFile()) {
          throw new PackageLifecycleError('invalid-package-store-file', 'refusing to replace non-regular package store state')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await this.#options.fault?.('before-rename')
      await rename(temporary, this.#file)
      renamed = true
      if (process.platform !== 'win32') await chmod(this.#file, 0o600)
      await syncDirectory(this.#root)
      await this.#options.fault?.('after-rename')
    } finally {
      await handle.close().catch(() => undefined)
      if (!renamed) await unlink(temporary).catch(() => undefined)
    }
  }
}
