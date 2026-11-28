import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import type { OwnerAdapterManagementContext } from './owner-adapter-sessions.js'

type Entry = {
  readonly context: OwnerAdapterManagementContext
  readonly authority: ManagerPermissionProofAuthority
  readonly retire: () => void
}

/** Per-document keys arrive only through the launcher's private pre-plugin bridge. */
export class OwnerAdapterPermissionProof {
  private readonly entries = new Map<string, Entry>()
  private closed = false

  constructor(private readonly scope: { readonly profileId: string; readonly generation: string }) {}

  register(context: OwnerAdapterManagementContext, keyId: unknown, key: unknown): void {
    if (
      this.closed || !context.current(false) || context.signal.aborted
      || typeof keyId !== 'string' || !/^[a-f0-9]{64}$/u.test(keyId)
      || this.entries.size >= 256
    ) throw new Error('adapter-permission-proof-unavailable')
    const id = `${context.rendererId}:${keyId}`
    if (this.entries.has(id)) throw new Error('adapter-permission-proof-unavailable')
    const authority = new ManagerPermissionProofAuthority({
      ...this.scope,
      target: 'native',
      isCurrent: () => context.current(false),
    })
    const renderer = {
      profileId: this.scope.profileId,
      ownerGeneration: this.scope.generation,
      rendererId: context.rendererId,
      signal: context.signal,
    }
    authority.register(renderer, key)
    const retire = () => {
      const entry = this.entries.get(id)
      if (entry?.authority !== authority) return
      this.entries.delete(id)
      context.signal.removeEventListener('abort', retire)
      authority.close()
    }
    this.entries.set(id, { context, authority, retire })
    context.signal.addEventListener('abort', retire, { once: true })
    if (!context.current(false)) {
      retire()
      throw new Error('adapter-permission-proof-unavailable')
    }
  }

  authorize(input: {
    readonly context: OwnerAdapterManagementContext
    readonly requestId: string
    readonly records: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly moduleGeneration: string
    readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
    readonly proof: unknown
  }): boolean {
    if (
      this.closed || !input.context.live() || !input.proof || typeof input.proof !== 'object'
      || Array.isArray(input.proof)
    ) return false
    const wrapper = input.proof as Record<string, unknown>
    if (
      Object.keys(wrapper).length !== 2 || typeof wrapper.keyId !== 'string'
      || !/^[a-f0-9]{64}$/u.test(wrapper.keyId) || !Object.hasOwn(wrapper, 'proof')
    ) return false
    const entry = this.entries.get(`${input.context.rendererId}:${wrapper.keyId}`)
    if (!entry || entry.context.signal !== input.context.signal) return false
    return entry.authority.authorize({
      context: {
        profileId: this.scope.profileId,
        ownerGeneration: this.scope.generation,
        rendererId: input.context.rendererId,
        signal: input.context.signal,
        admitted: true,
      },
      requestId: input.requestId,
      records: input.records,
      expected: input.expected,
      moduleGeneration: input.moduleGeneration,
      artifact: input.artifact,
      proof: wrapper.proof,
    })
  }

  authorizeOnce(input: {
    readonly context: OwnerAdapterManagementContext
    readonly requestId: string
    readonly record: CordisXPersistedPermissionPolicyRecord
    readonly decision: 'allow-once' | 'deny-once'
    readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly moduleGeneration: string
    readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
    readonly proof: unknown
  }): boolean {
    if (
      this.closed || !input.context.live() || !input.proof || typeof input.proof !== 'object'
      || Array.isArray(input.proof)
    ) return false
    const wrapper = input.proof as Record<string, unknown>
    if (
      Object.keys(wrapper).length !== 2 || typeof wrapper.keyId !== 'string'
      || !/^[a-f0-9]{64}$/u.test(wrapper.keyId) || !Object.hasOwn(wrapper, 'proof')
    ) return false
    const entry = this.entries.get(`${input.context.rendererId}:${wrapper.keyId}`)
    if (!entry || entry.context.signal !== input.context.signal) return false
    return entry.authority.authorizeOnce({
      context: {
        profileId: this.scope.profileId,
        ownerGeneration: this.scope.generation,
        rendererId: input.context.rendererId,
        signal: input.context.signal,
        admitted: true,
      },
      requestId: input.requestId,
      record: input.record,
      decision: input.decision,
      expected: input.expected,
      moduleGeneration: input.moduleGeneration,
      artifact: input.artifact,
      proof: wrapper.proof,
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.entries.values()) entry.retire()
  }
}
