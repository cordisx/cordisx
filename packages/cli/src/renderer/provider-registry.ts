import type { CordisXPlatformSessionRef } from '../contracts.js'

const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/

export type ProviderRegistryErrorCode = 'invalid-provider' | 'adapter-unavailable' | 'stale-generation'

export class ProviderRegistryError extends Error {
  constructor(readonly code: ProviderRegistryErrorCode, message: string) {
    super(message)
    this.name = 'ProviderRegistryError'
  }
}

export interface ProviderAdapterRegistration<Adapter> {
  readonly providerId: string
  readonly generation: string
  readonly adapter: Adapter
  readonly dispose?: () => void | Promise<void>
}

export interface ProviderAdapterLease<Adapter> {
  readonly providerId: string
  readonly generation: string
  readonly adapter: Adapter
  release(): void
}

export interface ProviderAdapterSnapshot {
  readonly providerId: string
  readonly generation: string
  readonly state: 'active' | 'draining'
  readonly inFlight: number
}

interface RecordState<Adapter> extends ProviderAdapterRegistration<Adapter> {
  state: 'active' | 'draining'
  inFlight: number
  finalizing: boolean
  failed: boolean
  resolveDrained: () => void
  rejectDrained: (error: unknown) => void
  drained: Promise<void>
}

function recordFor<Adapter>(registration: ProviderAdapterRegistration<Adapter>): RecordState<Adapter> {
  if (!PROVIDER_ID.test(registration.providerId)) throw new Error(`invalid provider id: ${registration.providerId}`)
  if (registration.generation.trim() === '') throw new Error('provider generation must be a non-empty string')
  return resetDrain({ ...registration, state: 'active', inFlight: 0, finalizing: false, failed: false })
}

function resetDrain<Adapter>(
  record: Omit<RecordState<Adapter>, 'resolveDrained' | 'rejectDrained' | 'drained'>,
): RecordState<Adapter> {
  let resolveDrained = (): void => {}
  let rejectDrained = (_error: unknown): void => {}
  const drained = new Promise<void>((resolve, reject) => {
    resolveDrained = resolve
    rejectDrained = reject
  })
  // A lease release has no awaiter. Keep the failure observable to later cleanup calls.
  void drained.catch(() => undefined)
  return Object.assign(record, { resolveDrained, rejectDrained, drained, failed: false })
}

/** Generation-fenced routing seat. Adapter-local ids enter only after a full provider reference resolves. */
export class ProviderAdapterRegistry<Adapter> {
  private readonly active = new Map<string, RecordState<Adapter>>()
  private readonly draining = new Set<RecordState<Adapter>>()
  private disposed = false

  register(registration: ProviderAdapterRegistration<Adapter>): () => Promise<void> {
    this.assertOpen()
    const record = recordFor(registration)
    this.assertGenerationAvailable(record)
    if (this.active.has(record.providerId)) throw new Error(`provider ${record.providerId} is already registered`)
    this.active.set(record.providerId, record)
    return async () => await this.remove(record)
  }

  replace(registration: ProviderAdapterRegistration<Adapter>): Promise<void> {
    this.assertOpen()
    const replacement = recordFor(registration)
    this.assertGenerationAvailable(replacement)
    const current = this.active.get(replacement.providerId)
    if (current === undefined) {
      this.active.set(replacement.providerId, replacement)
      return Promise.resolve()
    }
    if (current.generation === replacement.generation) {
      throw new Error(`provider ${replacement.providerId} generation did not change`)
    }
    current.state = 'draining'
    this.draining.add(current)
    this.active.set(replacement.providerId, replacement)
    void this.finalizeIfIdle(current)
    return current.drained
  }

  async replaceBatch(registrations: readonly ProviderAdapterRegistration<Adapter>[]): Promise<void> {
    this.assertOpen()
    const replacements = registrations.map(recordFor)
    const ids = new Set<string>()
    for (const replacement of replacements) {
      this.assertGenerationAvailable(replacement)
      if (ids.has(replacement.providerId)) throw new Error(`provider ${replacement.providerId} is registered twice`)
      ids.add(replacement.providerId)
      const current = this.active.get(replacement.providerId)
      if (current?.generation === replacement.generation) {
        throw new Error(`provider ${replacement.providerId} generation did not change`)
      }
    }
    const retired: RecordState<Adapter>[] = []
    for (const replacement of replacements) {
      const current = this.active.get(replacement.providerId)
      if (current !== undefined) {
        current.state = 'draining'
        this.draining.add(current)
        retired.push(current)
      }
      this.active.set(replacement.providerId, replacement)
    }
    for (const current of retired) void this.finalizeIfIdle(current).catch(() => undefined)
    await Promise.all(retired.map(current => current.drained))
  }

  async removeProvider(providerId: string, generation: string): Promise<boolean> {
    const record = [this.active.get(providerId), ...this.draining].find(item =>
      item?.providerId === providerId && item.generation === generation
    )
    if (record === undefined) return false
    await this.remove(record)
    return true
  }

  acquire(providerId: string, expectedGeneration?: string): ProviderAdapterLease<Adapter> {
    if (!PROVIDER_ID.test(providerId)) {
      throw new ProviderRegistryError('invalid-provider', 'Provider identity is invalid')
    }
    const record = this.active.get(providerId)
    if (record === undefined || record.state !== 'active') {
      throw new ProviderRegistryError('adapter-unavailable', `Provider ${providerId} is unavailable`)
    }
    if (expectedGeneration !== undefined && record.generation !== expectedGeneration) {
      throw new ProviderRegistryError('stale-generation', `Provider ${providerId} generation changed`)
    }
    record.inFlight += 1
    let released = false
    return Object.freeze({
      providerId: record.providerId,
      generation: record.generation,
      adapter: record.adapter,
      release: () => {
        if (released) return
        released = true
        record.inFlight -= 1
        void this.finalizeIfIdle(record)
      },
    })
  }

  acquireSession(ref: CordisXPlatformSessionRef, expectedGeneration?: string): ProviderAdapterLease<Adapter> {
    if (
      ref === null || typeof ref !== 'object' || Array.isArray(ref)
      || !PROVIDER_ID.test(ref.providerId)
      || typeof ref.remoteSessionId !== 'string'
      || ref.remoteSessionId.length === 0
      || ref.remoteSessionId.length > 512
    ) {
      throw new ProviderRegistryError('invalid-provider', 'A complete Platform session reference is required')
    }
    return this.acquire(ref.providerId, expectedGeneration)
  }

  snapshots(): readonly ProviderAdapterSnapshot[] {
    return [...this.active.values(), ...this.draining]
      .map(record => ({
        providerId: record.providerId,
        generation: record.generation,
        state: record.state,
        inFlight: record.inFlight,
      }))
      .sort((left, right) =>
        `${left.providerId}\0${left.generation}`.localeCompare(`${right.providerId}\0${right.generation}`)
      )
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const records = new Set([...this.active.values(), ...this.draining])
    this.active.clear()
    const results = await Promise.allSettled([...records].map(record => this.remove(record)))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Provider adapter cleanup failed')
  }

  private async remove(record: RecordState<Adapter>): Promise<void> {
    if (this.active.get(record.providerId) === record) this.active.delete(record.providerId)
    if (record.state === 'active') {
      record.state = 'draining'
      this.draining.add(record)
    }
    if (record.failed) resetDrain(record)
    void this.finalizeIfIdle(record)
    await record.drained
  }

  private async finalizeIfIdle(record: RecordState<Adapter>): Promise<void> {
    if (!this.draining.has(record) || record.inFlight !== 0 || record.finalizing || record.failed) return
    record.finalizing = true
    try {
      // Defer synchronous disposers too, so concurrent callers join the same attempt.
      await Promise.resolve().then(() => record.dispose?.())
      this.draining.delete(record)
      record.resolveDrained()
    } catch (error) {
      record.failed = true
      record.rejectDrained(error)
    } finally {
      record.finalizing = false
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('provider adapter registry is disposed')
  }

  private assertGenerationAvailable(registration: ProviderAdapterRegistration<Adapter>): void {
    if (
      [...this.draining].some(record =>
        record.providerId === registration.providerId && record.generation === registration.generation
      )
    ) throw new Error('Provider generation cleanup is incomplete')
  }
}
