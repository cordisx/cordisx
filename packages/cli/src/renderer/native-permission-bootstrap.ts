import { createStandalonePermissionSigner } from '../independent-manager/standalone-permission-signer.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'

/** Register an unexportable document key before any native plugin graph executes. */
export async function prepareNativePermissionBootstrap(
  metadata: CordisXRuntimeMetadata,
  signal?: AbortSignal,
): Promise<CordisXRuntimeMetadata> {
  if (metadata.nativeOwnerPermissionReview !== true) return metadata
  const binding = globalThis.__cordisxPermissionPolicyRequestV1
  const token = metadata.permissionBridgeToken
  const authority = metadata.ownerPolicyVerification
  if (
    metadata.hostKind === 'standalone' || metadata.ownerPermissionSnapshot !== true
    || typeof binding !== 'function' || typeof token !== 'string' || !authority || !metadata.generation
    || !globalThis.crypto?.getRandomValues
  ) throw new Error('native-permission-bootstrap-unavailable')
  signal?.throwIfAborted()
  const signer = await createStandalonePermissionSigner({
    rendererId: authority.rendererId,
    profileId: metadata.profileId,
    generation: metadata.generation,
  }, { target: 'native' })
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const keyId = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const requestId = `register-${keyId}`
  try {
    await new Promise<void>((resolve, reject) => {
      const previous = globalThis.__cordisxPermissionPolicyReceiveV1
      const timer = setTimeout(() => finish(false), 15_000)
      const abort = () => finish(false)
      const receive = (payload: string) => {
        try {
          const response = JSON.parse(payload) as { requestId?: unknown; ok?: unknown; value?: unknown }
          if (response.requestId === requestId) finish(response.ok === true && response.value === true)
        } catch { /* unrelated messages do not grant registration */ }
      }
      const finish = (accepted: boolean) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (globalThis.__cordisxPermissionPolicyReceiveV1 === receive) {
          globalThis.__cordisxPermissionPolicyReceiveV1 = previous
        }
        if (accepted && !signal?.aborted) resolve()
        else reject(new Error('native-permission-bootstrap-unavailable'))
      }
      globalThis.__cordisxPermissionPolicyReceiveV1 = receive
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) return finish(false)
      try {
        binding(JSON.stringify({ kind: 'register', requestId, token, keyId, key: signer.publicKey }))
      } catch {
        finish(false)
      }
    })
    return {
      ...metadata,
      standaloneReviewSession: async () => !signal?.aborted,
      standaloneWriteUncertain: () => {
        try {
          binding(JSON.stringify({ kind: 'retire', requestId: `retire-${keyId}`, token, keyId }))
        } finally {
          void globalThis.__cordisxRuntime?.dispose().catch(() => undefined)
        }
      },
      standalonePermissionSigner: {
        ...signer,
        sign: async (id, records) => ({ keyId, proof: await signer.sign(id, records) }),
        signOnce: async (id, review, plan, decision) => {
          const result = await signer.signOnce(id, review, plan, decision)
          return { ...result, proof: { keyId, proof: result.proof } }
        },
        signRuntimeOnce: async (id, plan, decision) => {
          const result = await signer.signRuntimeOnce(id, plan, decision)
          return { ...result, proof: { keyId, proof: result.proof } }
        },
      },
    }
  } catch (error) {
    signer.close()
    throw error
  }
}
