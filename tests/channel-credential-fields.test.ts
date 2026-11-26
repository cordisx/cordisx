import { expect, it } from 'vitest'
import { channelCredentialFailure } from '../packages/cli/src/renderer/channel-credential-fields.js'

it.each([
  { zh: true, explanation: '不一致' },
  { zh: false, explanation: 'does not match' },
])('places the tenant mismatch on the tenant field with localized guidance', ({ zh, explanation }) => {
  const failure = channelCredentialFailure('TENANT_MISMATCH', zh)
  expect(failure.id).toBe('channel-tenantId')
  expect(failure.message).toContain(explanation)
})
