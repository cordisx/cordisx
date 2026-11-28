import { type NativeRuntimeOnceProof, normalizeNativeRuntimeOnceProof } from './native-runtime-once-proof.js'
import { isStandaloneManagerDomTarget } from './standalone-permission-contract.js'

export interface WebRuntimeOnceProof extends Omit<NativeRuntimeOnceProof, 'kind'> {
  readonly kind: 'web-runtime-v2'
  readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
}

/** The owner's Web verifier accepts only an alias and the exact reviewed artifact. */
export function normalizeWebRuntimeOnceProof(value: unknown): WebRuntimeOnceProof {
  const invalid = (): never => {
    throw new Error('web-runtime-once-proof-invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const item = value as Record<string, unknown>
  if (
    item.kind !== 'web-runtime-v2' || !item.artifact || typeof item.artifact !== 'object'
    || Array.isArray(item.artifact)
  ) {
    return invalid()
  }
  const { artifact: rawArtifact, ...rest } = item
  const common = normalizeNativeRuntimeOnceProof({ ...rest, kind: 'native-runtime-v2' })
  const artifact = rawArtifact as Record<string, unknown>
  if (
    Object.keys(artifact).length !== 2 || typeof artifact.version !== 'string' || artifact.version.length === 0
    || artifact.version.length > 128 || /[\u0000-\u001f\u007f]/u.test(artifact.version)
    || typeof artifact.integrity !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(artifact.integrity)
    || !isStandaloneManagerDomTarget({
      id: common.record.key.identity.pluginId,
      source: common.record.key.identity.source,
    }, 'manager.content')
  ) return invalid()
  return {
    ...common,
    kind: 'web-runtime-v2',
    artifact: { version: artifact.version, integrity: artifact.integrity as `sha256:${string}` },
  }
}

export function webRuntimeOnceProofBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(normalizeWebRuntimeOnceProof(value)))
}
