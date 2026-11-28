import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareNativePermissionBootstrap } from '../packages/cli/src/renderer/native-permission-bootstrap.js'

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.__cordisxPermissionPolicyRequestV1 = undefined
  globalThis.__cordisxPermissionPolicyReceiveV1 = undefined
})

it('registers an unexportable native document key before returning the plugin bootstrap', async () => {
  vi.stubGlobal('crypto', webcrypto)
  let registration: Record<string, unknown> | undefined
  globalThis.__cordisxPermissionPolicyRequestV1 = payload => {
    registration = JSON.parse(payload) as Record<string, unknown>
    queueMicrotask(() =>
      globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
        requestId: registration!.requestId,
        ok: true,
        value: true,
      }))
    )
  }
  const prepared = await prepareNativePermissionBootstrap({
    profileId: 'default',
    generation: 'owner-1',
    ownerPermissionSnapshot: true,
    nativeOwnerPermissionReview: true,
    permissionBridgeToken: 'a'.repeat(64),
    ownerPolicyVerification: { rendererId: 'b'.repeat(64), publicKey: 'test' },
  } as never)
  expect(registration).toMatchObject({ kind: 'register', token: 'a'.repeat(64), key: { kty: 'EC', crv: 'P-256' } })
  expect(registration?.keyId).toMatch(/^[a-f0-9]{64}$/u)
  expect(prepared.standalonePermissionSigner).toBeDefined()
  expect(globalThis.__cordisxPermissionPolicyReceiveV1).toBeUndefined()
  prepared.standalonePermissionSigner?.close()
})

it('does not enable native review when registration is rejected', async () => {
  vi.stubGlobal('crypto', webcrypto)
  globalThis.__cordisxPermissionPolicyRequestV1 = payload => {
    const request = JSON.parse(payload) as { requestId: string }
    queueMicrotask(() =>
      globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
        requestId: request.requestId,
        ok: false,
      }))
    )
  }
  await expect(prepareNativePermissionBootstrap({
    profileId: 'default',
    generation: 'owner-1',
    ownerPermissionSnapshot: true,
    nativeOwnerPermissionReview: true,
    permissionBridgeToken: 'a'.repeat(64),
    ownerPolicyVerification: { rendererId: 'b'.repeat(64), publicKey: 'test' },
  } as never)).rejects.toThrow('native-permission-bootstrap-unavailable')
})
