import { expect, it, vi } from 'vitest'
import { DesktopChannelGrants } from '../packages/cli/src/launcher/desktop-channel-grants.js'

it('binds a short-lived single-use grant to the source, target and Channel actor', () => {
  vi.useFakeTimers()
  try {
    const grants = new DesktopChannelGrants()
    const event = {
      adapterId: 'test',
      accountId: 'account',
      tenantId: 'tenant',
      conversationId: 'chat',
      threadId: 'chat',
      kind: 'direct',
      semantics: 'conversation',
      eventId: 'event',
      actor: { adapterId: 'test', accountId: 'account', tenantId: 'tenant', userId: 'user' },
    } as const
    const target = { providerId: 'provider', model: 'model' }
    const code = grants.begin('source', target)
    expect(grants.consume(code, 'source', target, 'fresh' as never)).toBeUndefined()
    expect(grants.authorize(code, 'source', target, event, 'fresh' as never)).toBe(false)
    expect(grants.authorize(code, 'other', target, event, 'linked')).toBe(false)
    expect(grants.authorize(code, 'source', { ...target, model: 'other' }, event, 'linked')).toBe(false)
    expect(grants.authorize(code, 'source', target, event, 'linked')).toBe(true)
    expect(grants.authorize(code, 'source', target, event, 'linked')).toBe(false)
    expect(grants.consume(code, 'other', target, 'linked')).toBeUndefined()
    expect(grants.consume(code, 'source', { ...target, model: 'other' }, 'linked')).toBeUndefined()
    expect(grants.consume(code, 'source', target, 'linked')).toEqual(event)
    expect(grants.consume(code, 'source', target, 'linked')).toBeUndefined()
    const expired = grants.begin('source', target)
    vi.advanceTimersByTime(300_000)
    expect(grants.authorize(expired, 'source', target, event, 'linked')).toBe(false)
    expect(grants.consume(expired, 'source', target, 'linked')).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})
