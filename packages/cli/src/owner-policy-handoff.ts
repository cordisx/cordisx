import type { StandaloneDomPolicyAdoption } from './standalone-permission-contract.js'

/** An owner-signed transition; the public key is scoped to one adapter session. */
export interface OwnerPolicyPacket {
  readonly payload: string
  readonly signature: string
}

export interface OwnerPolicyTransition extends StandaloneDomPolicyAdoption {
  readonly profileId: string
  readonly ownerGeneration: string
  readonly rendererId: string
  readonly handoffId: string
  readonly origin: false
}

export function parseOwnerPolicyTransition(
  value: unknown,
  scope: { readonly profileId: string; readonly generation: string; readonly rendererId: string },
): OwnerPolicyTransition {
  const invalid = (): never => {
    throw new Error('owner-policy-handoff-invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const item = value as Record<string, unknown>
  const keys = [
    'profileId',
    'ownerGeneration',
    'rendererId',
    'handoffId',
    'requestId',
    'origin',
    'identity',
    'moduleGeneration',
    'expected',
    'updates',
    'candidate',
  ]
  if (
    Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
    || item.profileId !== scope.profileId || item.ownerGeneration !== scope.generation
    || item.rendererId !== scope.rendererId || item.origin !== false
    || typeof item.handoffId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.handoffId)
    || typeof item.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(item.requestId)
    || typeof item.moduleGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(item.moduleGeneration)
    || !item.identity || typeof item.identity !== 'object' || Array.isArray(item.identity)
    || !Array.isArray(item.expected) || item.expected.length > 64
    || !Array.isArray(item.updates) || item.updates.length !== 1
    || !Array.isArray(item.candidate) || item.candidate.length > 64
  ) return invalid()
  const identity = item.identity as Record<string, unknown>
  if (
    Object.keys(identity).length !== 2 || typeof identity.id !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(identity.id)
    || typeof identity.source !== 'string' || identity.source.length === 0 || identity.source.length > 4096
  ) return invalid()
  return item as unknown as OwnerPolicyTransition
}

export function parseOwnerPolicyPacket(value: unknown): OwnerPolicyPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('owner-policy-handoff-invalid')
  const packet = value as Record<string, unknown>
  if (
    Object.keys(packet).length !== 2 || typeof packet.payload !== 'string' || packet.payload.length > 131_072
    || typeof packet.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(packet.signature)
  ) throw new Error('owner-policy-handoff-invalid')
  return { payload: packet.payload, signature: packet.signature }
}
