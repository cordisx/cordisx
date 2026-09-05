import { afterEach, describe, expect, it } from 'vitest'
import { BindingPermissionPolicyStore } from '../packages/cli/src/renderer/permission-binding.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'

const globals = globalThis as typeof globalThis & {
  __cordisxPermissionPolicyRequestV1?: (payload: string) => void
  __cordisxPermissionPolicyReceiveV1?: (payload: string) => void
}

afterEach(() => {
  delete globals.__cordisxPermissionPolicyRequestV1
  delete globals.__cordisxPermissionPolicyReceiveV1
})

describe('renderer permission persistence binding', () => {
  it('sends only a token-bound atomic record batch and verifies readback', async () => {
    const token = 'a'.repeat(64)
    const record = createPermissionPolicyRecord({
      profileId: 'work',
      identity: { source: 'file:///plugins/demo.js', id: 'demo' },
      capability: 'models.read',
      scope: { providers: ['codex'] },
      policy: 'allow',
    })
    let payload: Record<string, unknown> | undefined
    globals.__cordisxPermissionPolicyRequestV1 = (text) => {
      payload = JSON.parse(text) as Record<string, unknown>
      queueMicrotask(() =>
        globals.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
          requestId: payload?.requestId,
          ok: true,
          value: [record],
        }))
      )
    }
    const store = BindingPermissionPolicyStore.connect(token, [])
    try {
      await store.write([record])
      expect(payload).toEqual({ requestId: expect.any(String), token, records: [record] })
      expect(JSON.stringify(payload)).not.toContain('configPath')
      expect(store.read()).toEqual([record])
    } finally {
      store.dispose()
    }
  })

  it('rejects a mismatched Host readback', async () => {
    const allow = createPermissionPolicyRecord({
      profileId: 'work',
      identity: { source: 'file:///plugins/demo.js', id: 'demo' },
      capability: 'models.read',
      scope: {},
      policy: 'allow',
    })
    const deny = { ...allow, policy: 'deny' as const }
    globals.__cordisxPermissionPolicyRequestV1 = (text) => {
      const payload = JSON.parse(text) as { requestId: string }
      queueMicrotask(() =>
        globals.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
          requestId: payload.requestId,
          ok: true,
          value: [deny],
        }))
      )
    }
    const store = BindingPermissionPolicyStore.connect('token', [])
    try {
      await expect(store.write([allow])).rejects.toThrow('mismatched records')
      expect(store.read()).toEqual([])
    } finally {
      store.dispose()
    }
  })
})
