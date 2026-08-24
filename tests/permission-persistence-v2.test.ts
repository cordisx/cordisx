import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V2 } from '../packages/cli/src/permission-contracts.js'
import { normalizePermissionPolicyRecordV2 } from '../packages/cli/src/permission-model-v2.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import {
  parsePermissionBindingRequest,
  persistPermissionPolicies,
} from '../packages/cli/src/launcher/permission-rpc.js'
import { BindingPermissionPolicyStore } from '../packages/cli/src/renderer/permission-binding.js'

const globals = globalThis as typeof globalThis & {
  __cordisxPermissionPolicyRequestV1?: (payload: string) => void
  __cordisxPermissionPolicyReceiveV1?: (payload: string) => void
}
const identity = { source: 'file:///plugins/demo.js', id: 'demo' } as const
const token = 'a'.repeat(64)
const temporary = new Set<string>()

function v2(policy: 'ask' | 'allow-persistent' | 'deny-persistent' = 'allow-persistent') {
  return normalizePermissionPolicyRecordV2({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
    schemaVersion: 2,
    key: {
      profileId: 'work',
      identity: { source: identity.source, pluginId: identity.id },
      capability: 'models.read',
      scope: { providers: ['codex'] },
      securityFingerprint: `sha256:${'a'.repeat(64)}`,
    },
    policy,
  })
}

const legacy = createPermissionPolicyRecord({
  profileId: 'work',
  identity,
  capability: 'models.read',
  scope: { providers: ['codex'] },
  policy: 'allow',
})

afterEach(async () => {
  delete globals.__cordisxPermissionPolicyRequestV1
  delete globals.__cordisxPermissionPolicyReceiveV1
  await Promise.all([...temporary].map(root => rm(root, { recursive: true, force: true })))
  temporary.clear()
})

describe('single permission persistence ledger v2 transition', () => {
  it('uses the existing token-bound bridge and retires the exact v1 record after v2 readback', async () => {
    const next = v2()
    let payload: { requestId: string; token: string; records: unknown[] } | undefined
    globals.__cordisxPermissionPolicyRequestV1 = (text) => {
      payload = JSON.parse(text) as typeof payload
      queueMicrotask(() => globals.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
        requestId: payload?.requestId,
        ok: true,
        value: [next],
      })))
    }
    const store = BindingPermissionPolicyStore.connect(token, [legacy])
    try {
      await store.writeV2([next])
      expect(payload).toEqual({ requestId: expect.any(String), token, records: [next] })
      expect(store.read()).toEqual([])
      expect(store.readV2()).toEqual([next])
      expect(JSON.stringify(payload)).not.toContain('configPath')
    } finally {
      store.dispose()
    }
  })

  it('keeps profile and Host-bound source identity unforgeable for v2 requests', () => {
    const context = { profileId: 'work', token, identities: [identity] }
    expect(parsePermissionBindingRequest({ requestId: 'request-1', token, records: [v2()] }, context))
      .toMatchObject({ records: [{ schemaVersion: 2, policy: 'allow-persistent' }] })
    const wrongProfile = {
      ...v2(),
      key: { ...v2().key, profileId: 'other' },
    }
    expect(() => parsePermissionBindingRequest({ requestId: 'request-1', token, records: [wrongProfile] }, context))
      .toThrow('profile is invalid')
    const spoofed = {
      ...v2(),
      key: { ...v2().key, identity: { source: 'file:///plugins/spoof.js', pluginId: identity.id } },
    }
    expect(() => parsePermissionBindingRequest({ requestId: 'request-1', token, records: [spoofed] }, context))
      .toThrow('identity is invalid')
  })

  it('atomically replaces only the exact migrated v1 key and preserves other plugin policies', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-permission-v2-'))
    temporary.add(root)
    const configPath = path.join(root, '.cordisx', 'config.json')
    await ensureHomeConfig(configPath)
    const other = createPermissionPolicyRecord({
      profileId: 'work',
      identity: { source: 'file:///plugins/other.js', id: 'other' },
      capability: 'models.read',
      scope: { providers: ['codex'] },
      policy: 'deny',
    })
    await persistPermissionPolicies({ configPath }, [legacy, other])
    await persistPermissionPolicies({ configPath }, [v2()])
    expect((await loadHomeConfig(configPath)).permissions).toEqual([other, v2()])
  })

  it('never serializes allow-once because v2 persistent policy rejects it', () => {
    expect(() => normalizePermissionPolicyRecordV2({
      ...v2(),
      policy: 'allow-once',
    })).toThrow('policy is unsupported')
  })
})
