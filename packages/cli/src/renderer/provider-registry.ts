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
  settled: boolean
  resolveDrained: () => void
  readonly drained: Promise<void>
}

function recordFor<Adapter>(registration: ProviderAdapterRegistration<Adapter>): RecordState<Adapter> {
  if (!PROVIDER_ID.test(registration.providerId)) throw new Error(`invalid provider id: ${registration.providerId}`)
  if (registration.generation.trim() === '') throw new Error('provider generation must be a non-empty string')
  let resolveDrained = (): void => {}
  const drained = new Promise<void>(resolve => { resolveDrained = resolve })
  return { ...registration, state: 'active', inFlight: 0, settled: false, resolveDrained, drained }
}

/** Generation-fenced routing seat. Adapter-local ids enter only after a full provider reference resolves. */
export class ProviderAdapterRegistry<Adapter> {
  private readonly active = new Map<string, RecordState<Adapter>>()
  private readonly draining = new Set<RecordState<Adapter>>()
  private disposed = false

  register(registration: ProviderAdapterRegistration<Adapter>): () => Promise<void> {
    this.assertOpen()
    const record = recordFor(registration)
    if (this.active.has(record.providerId)) throw new Error(`provider ${record.providerId} is already registered`)
    this.active.set(record.providerId, record)
    return async () => await this.remove(record)
  }

  replace(registration: ProviderAdapterRegistration<Adapter>): Promise<void> {
    this.assertOpen()
    const replacement = recordFor(registration)
    const current = this.active.get(replacement.providerId)
    if (current === undefined) {
      this.active.set(replacement.providerId, replacement)
      return Promise.resolve()
    }
    if (current.generation === replacement.generation) throw new Error(`provider ${replacement.providerId} generation did not change`)
    current.state = 'draining'
    this.draining.add(current)
    this.active.set(replacement.providerId, replacement)
    void this.finalizeIfIdle(current)
    return current.drained
  }

  acquire(providerId: string, expectedGeneration?: string): ProviderAdapterLease<Adapter> {
    if (!PROVIDER_ID.test(providerId)) throw new ProviderRegistryError('invalid-provider', 'Provider identity is invalid')
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
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)
      || !PROVIDER_ID.test(ref.providerId)
      || typeof ref.remoteSessionId !== 'string'
      || ref.remoteSessionId.length === 0
      || ref.remoteSessionId.length > 512) {
      throw new ProviderRegistryError('invalid-provider', 'A complete Platform session reference is required')
    }
    return this.acquire(ref.providerId, expectedGeneration)
  }

  snapshots(): readonly ProviderAdapterSnapshot[] {
    return [...this.active.values(), ...this.draining]
      .map(record => ({ providerId: record.providerId, generation: record.generation, state: record.state, inFlight: record.inFlight }))
      .sort((left, right) => `${left.providerId}\0${left.generation}`.localeCompare(`${right.providerId}\0${right.generation}`))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const records = [...this.active.values()]
    this.active.clear()
    for (const record of records) {
      record.state = 'draining'
      this.draining.add(record)
      void this.finalizeIfIdle(record)
    }
    await Promise.all([...this.draining].map(record => record.drained))
  }

  private async remove(record: RecordState<Adapter>): Promise<void> {
    if (this.active.get(record.providerId) === record) this.active.delete(record.providerId)
    if (record.state === 'active') {
      record.state = 'draining'
      this.draining.add(record)
    }
    void this.finalizeIfIdle(record)
    await record.drained
  }

  private async finalizeIfIdle(record: RecordState<Adapter>): Promise<void> {
    if (record.state !== 'draining' || record.inFlight !== 0 || record.settled) return
    record.settled = true
    try {
      await record.dispose?.()
    } finally {
      this.draining.delete(record)
      record.resolveDrained()
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('provider adapter registry is disposed')
  }
}
