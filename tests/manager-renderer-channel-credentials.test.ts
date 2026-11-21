import { expect, it, vi } from 'vitest'
import { createManagerRendererChannelCredentials } from '../packages/cli/src/cli/manager-renderer-channel-credentials.js'

it('admits only bounded, owner-scoped existing-account credential operations', () => {
  const handle = vi.fn()
  const channel = createManagerRendererChannelCredentials({
    profileId: 'profile',
    generation: 'generation',
    configPath: '/fixture/config.json',
    plugin: {} as never,
    service: {} as never,
    authority: {} as never,
    bootstrap: {} as never,
    participants: {} as never,
    lifecycle: {} as never,
    sessions: () => ({} as never),
    handle,
  }).channel
  const context = {
    profileId: 'profile',
    ownerGeneration: 'generation',
    rendererId: 'a'.repeat(64),
    signal: new AbortController().signal,
    admitted: true,
  }
  const request = {
    version: 2,
    token: 'renderer-binding-placeholder',
    requestId: 'capture',
    operation: 'capture',
    owner: 'form',
    purpose: 'rotate',
    account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant' },
    secret: 'synthetic-fixture-value',
    expectedRevision: 1,
  }
  expect(channel.prepare(JSON.stringify(request), context).mode).toBe('write')
  for (
    const value of [
      { ...request, purpose: 'create' },
      { ...request, account: { ...request.account, tenantId: '' } },
      { ...request, token: 'wrong' },
      { ...request, extra: true },
      { ...request, secret: 'x'.repeat(140_000) },
    ]
  ) {
    expect(() => channel.prepare(JSON.stringify(value), context)).toThrow('CHANNEL_CREDENTIAL_UNAVAILABLE')
  }
  expect(() => channel.prepare('{"secret":"synthetic-fixture-value', context))
    .toThrow('CHANNEL_CREDENTIAL_UNAVAILABLE')
  expect(() => channel.prepare(JSON.stringify(request), { ...context, admitted: false }))
    .toThrow('CHANNEL_CREDENTIAL_UNAVAILABLE')
  expect(handle).not.toHaveBeenCalled()
})
