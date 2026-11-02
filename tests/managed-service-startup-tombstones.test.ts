import { describe, expect, it } from 'vitest'
import { ManagedServiceStartupTombstones } from '../packages/cli/src/launcher/managed-service-startup-tombstones.js'

const request = (token: string) => ({
  version: 1,
  token,
  operation: 'startupNext',
  requestId: 'request',
  scope: { profileId: 'profile', runtimeGeneration: 'runtime', pluginGeneration: 'one' },
})
describe('retired startup route receipts', () => {
  it('returns typed termination only for an issued token and exact startup scope', () => {
    const receipts = new ManagedServiceStartupTombstones('profile', 'runtime')
    receipts.retire('issued', { pluginId: 'example', pluginGeneration: 'one' }, 'scope-revoked')
    expect(receipts.result(request('issued'))).toEqual({ status: 'startup-terminated', reason: 'scope-revoked' })
    expect(receipts.result(request('unknown'))).toBeUndefined()
    expect(receipts.result({ ...request('issued'), operation: 'snapshot' })).toBeUndefined()
    expect(
      receipts.result({ ...request('issued'), scope: { ...request('issued').scope, pluginGeneration: 'foreign' } }),
    ).toBeUndefined()
    expect(receipts.result({ ...request('issued'), scope: { ...request('issued').scope, pluginId: 'spoofed' } }))
      .toBeUndefined()
  })
  it('bounds retired generation memory without authorizing an evicted token', () => {
    const receipts = new ManagedServiceStartupTombstones('profile', 'runtime', 2)
    for (const token of ['one', 'two', 'three']) {
      receipts.retire(token, { pluginId: 'example', pluginGeneration: 'one' }, 'host-replaced')
    }
    expect(receipts.result(request('one'))).toBeUndefined()
    expect(receipts.result(request('three'))).toMatchObject({ reason: 'host-replaced' })
  })
})
