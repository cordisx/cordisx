import { expect, it } from 'vitest'
import {
  channelCredentialFailure,
  validateChannelCredentialValues,
} from '../packages/cli/src/renderer/channel-credential-fields.js'

it.each([
  { zh: true, explanation: '不一致' },
  { zh: false, explanation: 'does not match' },
])('places the tenant mismatch on the tenant field with localized guidance', ({ zh, explanation }) => {
  const failure = channelCredentialFailure('TENANT_MISMATCH', zh)
  expect(failure.id).toBe('channel-tenantId')
  expect(failure.message).toContain(explanation)
})

it('accepts an empty tenant for automatic lookup but rejects malformed manual values', () => {
  const credentials = { appId: 'cli_fixture', secret: 'fixture-secret', tenantId: '' }
  expect(validateChannelCredentialValues(credentials, false).has('channel-tenantId')).toBe(false)
  for (const tenantId of ['   ', 'x'.repeat(513), 'tenant\u0000invalid']) {
    expect(validateChannelCredentialValues({ ...credentials, tenantId }, false).has('channel-tenantId')).toBe(true)
  }
  expect(validateChannelCredentialValues({ ...credentials, tenantId: 'fixture-tenant' }, false).size).toBe(0)
})
