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
  readonly value: unknown
}

function equalJson(left: unknown, right: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (left === right) return left !== undefined && (typeof left !== 'number' || Number.isFinite(left))
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index], depth + 1))
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort()
  return keys.length === other.length
    && keys.every((key, index) => key === other[index] && equalJson(a[key], b[key], depth + 1))
}

/** One owner-confirmed live update, adopted without replacing the Manager document. */
export class BrowserStandaloneDesktopPackageConfigBridge {
  private disposed = false
  private pending: {
    readonly requestId: string
    readonly pluginId: string
    readonly expectedRevision: number
    readonly candidate: ConfigCandidate
    readonly adopt: (revision: number) => void
    readonly resolve: () => void
    readonly reject: (error: Error) => void
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
    if (this.disposed || this.pending || typeof binding !== 'function') {
      return Promise.reject(new Error('plugin configuration is unavailable'))
    }
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.unknown(), 75_000)
      this.pending = { requestId, pluginId, expectedRevision, candidate, adopt, resolve, reject, timer, adopted: false }
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
        reject(new Error('plugin configuration is unavailable'))
      }
    })
  }

  adopt(value: StandaloneDesktopConfigAdoption): boolean {
    const pending = this.pending
    if (
      this.disposed || !pending || pending.adopted || value.requestId !== pending.requestId
      || value.pluginId !== pending.pluginId || value.expectedRevision !== pending.expectedRevision
      || value.revision !== pending.expectedRevision + 1 || !equalJson(value.value, pending.candidate.raw)
    ) return false
    pending.adopted = true
    try {
      pending.adopt(value.revision)
      return true
    } catch {
      return false
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
      pending.reject(new Error('plugin configuration result is unknown'))
    }
  }

  private unknown(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timer)
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
