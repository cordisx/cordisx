import type { ConfigCandidate, ConfigMutationOperation } from './configuration/model.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'

const BINDING = '__cordisxDesktopPackageConfigRequestV1'
const RECEIVER = '__cordisxDesktopPackageConfigReceiveV1'
type Binding = (payload: string) => void

declare global {
  var __cordisxDesktopPackageConfigRequestV1: Binding | undefined
  var __cordisxDesktopPackageConfigReceiveV1: Binding | undefined
}

export interface StandaloneDesktopConfigAdoption {
  readonly requestId: string
  readonly pluginId: string
  readonly expectedRevision: number
  readonly revision: number
  readonly origin: boolean
  readonly operations: readonly ConfigMutationOperation[]
  readonly value: unknown
}

export function equalStandaloneConfigJson(left: unknown, right: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (left === right) return left !== undefined && (typeof left !== 'number' || Number.isFinite(left))
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalStandaloneConfigJson(value, right[index], depth + 1))
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort()
  return keys.length === other.length
    && keys.every((key, index) => key === other[index] && equalStandaloneConfigJson(a[key], b[key], depth + 1))
}

function isStandaloneConfigValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  return Array.isArray(value) && value.length <= 256
    && value.every(item =>
      typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)
    )
}

/** Only bounded primitive operations admitted by the Desktop owner can cross this bridge. */
export function isStandaloneConfigOperations(value: unknown): value is readonly ConfigMutationOperation[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const operation = item as Record<string, unknown>
    const keys = Object.keys(operation)
    if (
      operation.op !== 'set' && operation.op !== 'unset'
      || keys.length !== (operation.op === 'set' ? 3 : 2)
      || keys.some(key => !['op', 'path', ...(operation.op === 'set' ? ['value'] : [])].includes(key))
      || !Array.isArray(operation.path) || operation.path.length === 0 || operation.path.length > 32
      || operation.path.some(part =>
        typeof part !== 'string' || part.length === 0 || part.length > 128
        || ['__proto__', 'prototype', 'constructor'].includes(part)
      )
    ) return false
    return operation.op === 'unset' || Object.hasOwn(operation, 'value') && isStandaloneConfigValue(operation.value)
  })
}

/** One owner-confirmed live update, adopted without replacing the Manager document. */
export class BrowserStandaloneDesktopPackageConfigBridge {
  private disposed = false
  private adoptingPeer = false
  private pending: {
    readonly requestId: string
    readonly pluginId: string
    readonly expectedRevision: number
    readonly operations: readonly ConfigMutationOperation[]
    readonly candidate: ConfigCandidate
    readonly adopt: (revision: number) => void
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    readonly settled: Promise<void>
    readonly settle: () => void
    readonly timer: ReturnType<typeof setTimeout>
    adopted: boolean
  } | undefined

  constructor(private readonly token: string, private readonly onUnknown?: () => void) {
    if (globalThis[RECEIVER] !== undefined) throw new Error('desktop package configuration receiver is unavailable')
    globalThis[RECEIVER] = this.receive
  }

  request(
    pluginId: string,
    expectedRevision: number,
    operations: readonly ConfigMutationOperation[],
    candidate: ConfigCandidate,
    adopt: (revision: number) => void,
  ): Promise<void> {
    const binding = globalThis[BINDING]
    if (
      this.disposed || this.pending || this.adoptingPeer || typeof binding !== 'function'
      || !isStandaloneConfigOperations(operations)
    ) {
      return Promise.reject(new Error('plugin configuration is unavailable'))
    }
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      let settle!: () => void
      const settled = new Promise<void>(done => settle = done)
      const timer = setTimeout(() => this.unknown(), 75_000)
      this.pending = {
        requestId,
        pluginId,
        expectedRevision,
        operations: structuredClone(operations),
        candidate,
        adopt,
        resolve,
        reject,
        settled,
        settle,
        timer,
        adopted: false,
      }
      try {
        binding(JSON.stringify({
          version: 1,
          token: this.token,
          requestId,
          operation: { kind: 'plugin-configuration', action: 'update', pluginId, expectedRevision, operations },
        }))
      } catch {
        clearTimeout(timer)
        this.pending = undefined
        settle()
        reject(new Error('plugin configuration is unavailable'))
      }
    })
  }

  adopt(value: StandaloneDesktopConfigAdoption): boolean {
    const pending = this.pending
    if (
      this.disposed || !value.origin || !pending || pending.adopted || value.requestId !== pending.requestId
      || value.pluginId !== pending.pluginId || value.expectedRevision !== pending.expectedRevision
      || value.revision !== pending.expectedRevision + 1
      || !equalStandaloneConfigJson(value.operations, pending.operations)
      || !equalStandaloneConfigJson(value.value, pending.candidate.raw)
    ) return false
    pending.adopted = true
    try {
      pending.adopt(value.revision)
      return true
    } catch {
      return false
    }
  }

  /** Block new local saves while this page adopts an owner-confirmed peer write. */
  async adoptPeer(value: StandaloneDesktopConfigAdoption, adopt: () => Promise<boolean>): Promise<boolean> {
    if (this.disposed || value.origin || this.adoptingPeer) return false
    this.adoptingPeer = true
    try {
      // The owner has already drained other dispatched writes, but a rejected
      // response can still be in transit to this browser.
      await this.pending?.settled
      if (this.disposed || this.pending) return false
      return await adopt() && !this.disposed
    } catch {
      return false
    } finally {
      this.adoptingPeer = false
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (globalThis[RECEIVER] === this.receive) globalThis[RECEIVER] = undefined
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.settle()
      pending.reject(new Error('plugin configuration result is unknown'))
    }
  }

  private unknown(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.settle()
    pending.reject(new Error('plugin configuration result is unknown'))
    try {
      this.onUnknown?.()
    } catch { /* The session must still remain unavailable. */ }
  }

  private readonly receive = (payload: string): void => {
    const pending = this.pending
    if (!pending) return
    let response: { requestId?: unknown; ok?: unknown; value?: unknown }
    try {
      response = JSON.parse(payload) as typeof response
    } catch {
      this.unknown()
      return
    }
    if (response?.requestId !== pending.requestId) return
    const value = response.value !== null && typeof response.value === 'object' && !Array.isArray(response.value)
      ? response.value as Record<string, unknown>
      : undefined
    if (response.ok === true && value?.status === 'rejected' && !pending.adopted) {
      this.pending = undefined
      clearTimeout(pending.timer)
      pending.settle()
      pending.reject(new Error('plugin configuration is unavailable or in use'))
      return
    }
    if (
      response.ok !== true || value?.status !== 'applied' || value.revision !== pending.expectedRevision + 1
      || !pending.adopted
    ) {
      this.unknown()
      return
    }
    this.pending = undefined
    clearTimeout(pending.timer)
    pending.settle()
    pending.resolve()
  }
}

/** The runtime owns and disposes this bridge only for an owner-issued standalone scope. */
export function createStandaloneDesktopPackageConfigBridge(
  metadata: CordisXRuntimeMetadata,
): BrowserStandaloneDesktopPackageConfigBridge | undefined {
  return metadata.hostKind === 'standalone' && metadata.standaloneDesktopPackageConfig !== undefined
    ? new BrowserStandaloneDesktopPackageConfigBridge(
      metadata.standaloneDesktopPackageConfig.token,
      metadata.standaloneWriteUncertain,
    )
    : undefined
}
