import { randomBytes } from 'node:crypto'

/** The same private lifecycle methods used by the existing renderer federation. */
export type ManagerRendererCommandMethod =
  | 'synchronize'
  | 'prepare'
  | 'stage'
  | 'publish'
  | 'complete'
  | 'finalize'
  | 'rollback'
  | 'quiesce'
  | 'channel-configuration'
  | 'managed-service-state'

export interface ManagerRendererPeerScope {
  readonly homeDigest: string
  readonly ownerAppId: string
  readonly profileId: string
  readonly generation: string
}

export interface ManagerRendererPeerIdentity {
  readonly appId: string
  readonly adapterId: string
  readonly rendererId: string
  readonly pid: number
  readonly processStartedAt: string
}

export interface ManagerRendererCommand {
  readonly id: string
  readonly sequence: number
  readonly method: ManagerRendererCommandMethod
  readonly payload: unknown
}

/** Installed only by the authenticated owner before the peer is admitted. */
export type OwnerCommandProjection = (method: ManagerRendererCommandMethod, payload: unknown) => {
  readonly payload: unknown
  readonly receipt?: (value: unknown) => unknown
}

const methods = new Set<ManagerRendererCommandMethod>([
  'synchronize',
  'prepare',
  'stage',
  'publish',
  'complete',
  'finalize',
  'rollback',
  'quiesce',
  'channel-configuration',
  'managed-service-state',
])
const MAX_COMMAND_BYTES = 256 * 1024
// Channel views omit images but can still describe many configured accounts.
// Keep the whole poll response below the browser pump's one-megabyte limit.
const MAX_CHANNEL_COMMAND_BYTES = 900 * 1024
const MAX_RESULT_BYTES = 8 * 1024 * 1024

function cloneBounded(value: unknown, maxBytes: number): unknown {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) throw new Error('renderer-command-invalid')
  return JSON.parse(encoded) as unknown
}

/**
 * Owner-side transport primitive; no browser or HTTP endpoint enables it yet.
 * Metadata must be constructed from an already authenticated owner session.
 * Commands are handed out at most once. A missing receipt closes the peer so
 * lifecycle callers must reconcile rather than replay a possibly applied step.
 */
export class ManagerRendererCommandPeer {
  readonly scope: ManagerRendererPeerScope
  readonly identity: ManagerRendererPeerIdentity
  readonly sessionId: string
  private readonly timeoutMs: number
  private readonly listeners = new Set<() => void>()
  private projection: OwnerCommandProjection | undefined
  private sequence = 0
  private ended = false
  private pending: {
    readonly command: ManagerRendererCommand
    readonly timer: ReturnType<typeof setTimeout>
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
    readonly receipt?: (value: unknown) => unknown
    offered: boolean
  } | undefined
  private waiter: {
    readonly resolve: (command: ManagerRendererCommand | undefined) => void
    readonly timer: ReturnType<typeof setTimeout>
    readonly signal?: AbortSignal
    readonly abort: () => void
  } | undefined

  constructor(input: {
    readonly scope: ManagerRendererPeerScope
    readonly identity: ManagerRendererPeerIdentity
    readonly sessionId: string
    readonly timeoutMs?: number
  }) {
    const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
    if (
      !/^[a-f0-9]{64}$/u.test(input.scope.homeDigest)
      || ![
        input.scope.ownerAppId,
        input.scope.profileId,
        input.scope.generation,
        input.identity.appId,
        input.identity.adapterId,
        input.identity.rendererId,
      ].every(value => id.test(value))
      || !Number.isSafeInteger(input.identity.pid) || input.identity.pid <= 0
      || typeof input.identity.processStartedAt !== 'string' || input.identity.processStartedAt.length < 1
      || input.identity.processStartedAt.length > 256 || !/^[a-f0-9]{64}$/u.test(input.sessionId)
    ) throw new Error('renderer-peer-invalid')
    this.timeoutMs = input.timeoutMs ?? 15_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error('renderer-peer-timeout-invalid')
    }
    this.scope = Object.freeze({ ...input.scope })
    this.identity = Object.freeze({ ...input.identity })
    this.sessionId = input.sessionId
  }

  get closed(): boolean {
    return this.ended
  }

  bindOwnerProjection(projection: OwnerCommandProjection): void {
    if (this.ended || this.pending || this.sequence !== 0 || this.projection || typeof projection !== 'function') {
      throw new Error('renderer-command-projection-unavailable')
    }
    this.projection = projection
  }

  request(method: ManagerRendererCommandMethod, payload: unknown): Promise<unknown> {
    if (this.ended || this.pending !== undefined || !methods.has(method) || this.sequence >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error('renderer-command-unavailable'))
    }
    let cloned: unknown
    let receipt: ((value: unknown) => unknown) | undefined
    try {
      const projected = this.projection?.(method, payload) ?? { payload }
      cloned = cloneBounded(
        projected.payload,
        method === 'channel-configuration' ? MAX_CHANNEL_COMMAND_BYTES : MAX_COMMAND_BYTES,
      )
      receipt = projected.receipt
    } catch {
      return Promise.reject(new Error('renderer-command-invalid'))
    }
    const command = Object.freeze({
      id: randomBytes(32).toString('hex'),
      sequence: ++this.sequence,
      method,
      payload: cloned,
    })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), this.timeoutMs)
      timer.unref()
      this.pending = { command, timer, resolve, reject, offered: false, ...(receipt === undefined ? {} : { receipt }) }
      if (this.waiter !== undefined) {
        this.pending.offered = true
        this.finishWaiter(command)
      }
    })
  }

  /** Only the authenticated session's HTTP poller may call this method. */
  async next(input: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<
    ManagerRendererCommand | undefined
  > {
    if (this.ended || input.signal?.aborted) return undefined
    if (this.waiter !== undefined) throw new Error('renderer-command-poll-in-progress')
    const timeout = input.timeoutMs ?? 20_000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error('renderer-command-poll-invalid')
    if (this.pending !== undefined && !this.pending.offered) {
      this.pending.offered = true
      return this.pending.command
    }
    if (this.pending?.offered) throw new Error('renderer-command-awaiting-receipt')
    return await new Promise(resolve => {
      const timer = setTimeout(() => this.finishWaiter(undefined), timeout)
      timer.unref()
      const abort = () => this.finishWaiter(undefined)
      this.waiter = { resolve, timer, abort, ...(input.signal === undefined ? {} : { signal: input.signal }) }
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
    })
  }

  private finishWaiter(command: ManagerRendererCommand | undefined): void {
    const waiter = this.waiter
    if (waiter === undefined) return
    this.waiter = undefined
    clearTimeout(waiter.timer)
    waiter.signal?.removeEventListener('abort', waiter.abort)
    waiter.resolve(command)
  }

  /** A receipt cannot select another request or replay a previous sequence. */
  acknowledge(value: unknown): boolean {
    if (this.ended || value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    const pending = this.pending
    if (
      pending === undefined || !pending.offered || item.id !== pending.command.id
      || item.sequence !== pending.command.sequence || typeof item.ok !== 'boolean'
      || Object.keys(item).some(key => !['id', 'sequence', 'ok', 'value'].includes(key))
    ) return false
    if (item.ok !== true) {
      this.close()
      return true
    }
    let result: unknown
    try {
      result = cloneBounded(item.value, MAX_RESULT_BYTES)
      if (pending.receipt) result = cloneBounded(pending.receipt(result), MAX_RESULT_BYTES)
    } catch {
      this.close()
      return false
    }
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.resolve(result)
    return true
  }

  onDisconnect(listener: () => void): () => void {
    if (this.ended) {
      try {
        listener()
      } catch { /* isolate one listener */ }
      return () => {}
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    this.finishWaiter(undefined)
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      pending.reject(new Error('renderer-command-result-unknown'))
    }
    for (const listener of this.listeners) {
      try {
        listener()
      } catch { /* isolate one listener */ }
    }
    this.listeners.clear()
  }
}
