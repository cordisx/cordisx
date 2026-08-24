import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  parsePermissionBindingRequest,
  persistPermissionPolicies,
} from '../packages/cli/src/launcher/permission-rpc.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'

const identity = { source: 'file:///plugins/demo.js', id: 'demo' }
const token = 'a'.repeat(64)

function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    requestId: 'request-1',
    token,
    records: [createPermissionPolicyRecord({
      profileId: 'work',
      identity,
      capability: 'models.read',
      scope: { providers: ['codex'] },
      policy: 'allow',
    })],
    ...overrides,
  }
}

describe('permission persistence RPC', () => {
  it('binds profile and known launcher identity while rejecting spoofed or malformed input', () => {
    const context = { profileId: 'work', token, identities: [identity] }
    expect(parsePermissionBindingRequest(request(), context)).toMatchObject({
      records: [{ key: { profileId: 'work', identity: { pluginId: 'demo' } }, policy: 'allow' }],
    })
    expect(() => parsePermissionBindingRequest(request({ token: 'b'.repeat(64) }), context)).toThrow('token is invalid')
    expect(() => parsePermissionBindingRequest(request({
      records: [createPermissionPolicyRecord({
        profileId: 'other', identity, capability: 'models.read', scope: {}, policy: 'allow',
      })],
    }), context)).toThrow('profile is invalid')
    expect(() => parsePermissionBindingRequest(request({
      records: [createPermissionPolicyRecord({
        profileId: 'work',
        identity: { source: 'file:///plugins/spoof.js', id: 'demo' },
        capability: 'models.read', scope: {}, policy: 'allow',
      })],
    }), context)).toThrow('identity is invalid')
    expect(() => parsePermissionBindingRequest({
      ...(request() as Record<string, unknown>),
      records: [{
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-policy.v1.schema.json',
        schemaVersion: 1,
        key: { profileId: 'work', identity: { source: identity.source, pluginId: identity.id }, capability: 'models.read', scope: { sessionIds: ['agent-1'] } },
        policy: 'allow',
      }],
    }, context)).toThrow('cannot use Agent sessionIds')
  })

  it('atomically persists and reads back only the normalized policy record', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-permission-rpc-'))
    const configPath = path.join(root, '.cordisx', 'config.json')
    await ensureHomeConfig(configPath)
    const parsed = parsePermissionBindingRequest(request(), { profileId: 'work', token, identities: [identity] })
    await expect(persistPermissionPolicies({ configPath }, parsed.records)).resolves.toEqual(parsed.records)
    const readback = await loadHomeConfig(configPath)
    expect(readback.permissions).toEqual(parsed.records)

    const deny = createPermissionPolicyRecord({
      profileId: 'work', identity, capability: 'models.read', scope: { providers: ['codex'] }, policy: 'deny',
    })
    const optionalDeny = createPermissionPolicyRecord({
      profileId: 'work', identity, capability: 'tasks.catalog.read', scope: {}, policy: 'deny',
    })
    await persistPermissionPolicies({ configPath }, [deny, optionalDeny])
    expect((await loadHomeConfig(configPath)).permissions).toEqual([deny, optionalDeny])
  })
})
