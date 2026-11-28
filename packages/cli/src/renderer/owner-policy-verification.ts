import {
  type OwnerPolicyTransition,
  parseOwnerPolicyPacket,
  parseOwnerPolicyTransition,
} from '../owner-policy-handoff.js'

function decode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Verify the service signature before interpreting a policy transition from the renderer. */
export async function verifyOwnerPolicyPacket(
  raw: unknown,
  scope: { readonly profileId: string; readonly generation: string; readonly rendererId: string; readonly key: string },
): Promise<OwnerPolicyTransition | undefined> {
  try {
    if (!/^[A-Za-z0-9_-]{59}$/u.test(scope.key)) return undefined
    const packet = parseOwnerPolicyPacket(raw)
    const key = await crypto.subtle.importKey('spki', decode(scope.key), { name: 'Ed25519' }, false, ['verify'])
    if (
      !await crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        decode(packet.signature),
        new TextEncoder().encode(packet.payload),
      )
    ) {
      return undefined
    }
    return parseOwnerPolicyTransition(JSON.parse(packet.payload), scope)
  } catch {
    return undefined
  }
}
