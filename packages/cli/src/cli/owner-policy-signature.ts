import { generateKeyPairSync, sign } from 'node:crypto'
import type { OwnerPolicyPacket, OwnerPolicyTransition } from '../owner-policy-handoff.js'

/** The secret stays in the service; only the session-specific verifier reaches its client. */
export function createOwnerPolicySigner(): {
  readonly publicKey: string
  sign(transition: OwnerPolicyTransition): OwnerPolicyPacket
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    sign(transition) {
      const payload = JSON.stringify(transition)
      if (Buffer.byteLength(payload) > 131_072) throw new Error('owner-policy-handoff-invalid')
      return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url') }
    },
  }
}
