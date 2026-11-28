import { expect, it } from 'vitest'
import { parseManagedServiceAccountAdoption } from '../packages/cli/src/managed-service-account-adoption.js'

const scope = { profileId: 'default', generation: 'owner-1', rendererId: 'a'.repeat(64) }
const binding = {
  bindingId: 'binding-1',
  identity: { pluginId: 'plugin', serviceId: 'gateway' },
  scope: { profileId: scope.profileId, generation: scope.generation },
}
const accounts = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-accounts.v1.schema.json',
  contract: 'cordisx.managed-service-cli-proxy-accounts/v1',
  schemaVersion: 1,
  binding,
  sequence: 1,
  observedAt: '2026-01-01T00:00:00Z',
  revision: 4,
  serviceGeneration: 'service-1',
  accounts: [],
}
const payload = {
  rendererId: scope.rendererId,
  ownerGeneration: scope.generation,
  requestId: 'request-1',
  pluginId: 'plugin',
  pluginGeneration: 'plugin-1',
  serviceId: 'gateway',
  phase: 'prepare',
  binding,
  accounts,
}

it('accepts only the owner-bound account projection and a matching cancellation', () => {
  expect(parseManagedServiceAccountAdoption(payload, scope)).toMatchObject({
    phase: 'prepare',
    accounts: { revision: 4 },
  })
  const { accounts: _accounts, ...cancel } = payload
  expect(parseManagedServiceAccountAdoption({ ...cancel, phase: 'cancel' }, scope)).toMatchObject({ phase: 'cancel' })
})

it.each([
  { ...payload, rendererId: 'b'.repeat(64) },
  { ...payload, pluginId: 'other' },
  { ...payload, phase: 'unknown' },
  { ...payload, accounts: { ...accounts, binding: { ...binding, bindingId: 'other' } } },
  { ...payload, accounts: { ...accounts, accounts: [{ token: 'not allowed' }] } },
  { ...payload, accounts: { ...accounts, revision: -1 } },
])('rejects stale, malformed or secret-bearing handoffs', value => {
  expect(() => parseManagedServiceAccountAdoption(value, scope)).toThrow('renderer-managed-account-unavailable')
})
