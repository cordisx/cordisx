import { describe, expect, it, vi } from 'vitest'
import { desktopLogicalIdentity } from '../packages/cli/src/launcher/desktop-logical-identity.js'
import { harness } from './fixtures/native-submission-channel-harness.js'

describe('desktop logical identity admission', () => {
  it('reads the native account only from the current bound desktop scope', async () => {
    let account = JSON.stringify(['account', 'user'])
    const h = await harness({ nativeAccount: () => account })
    const scope = { ...h.draft, composerId: 'main', threadId: 'thread' }
    try {
      h.setLive(scope)
      await h.channel.selectionRead({ scope, effective: { providerId: 'openai', model: 'native' } })
      const first = await h.authority.desktopIdentity(scope)
      expect(first).toMatch(/^desktop:[a-f0-9]{64}$/u)
      account = JSON.stringify(['account', 'other-user'])
      const other = await h.authority.desktopIdentity(scope)
      expect(other).not.toBe(first)
      h.setLive({ ...scope, navigationGeneration: scope.navigationGeneration + 1 })
      expect(await h.authority.desktopIdentity(scope)).toBeUndefined()
      expect(await h.authority.desktopOwnerIdentity(scope)).toBe(other)
    } finally {
      await h.installed.dispose()
    }
    expect(await h.authority.desktopIdentity(scope)).toBeUndefined()
    expect(await h.authority.desktopOwnerIdentity(scope)).toBeUndefined()
  })
  it('binds the active scope to the same native user across asynchronous reads', async () => {
    const current = vi.fn(async () => true)
    const read = vi.fn(async () => JSON.stringify(['account', 'user']))
    const identity = await desktopLogicalIdentity({ current, read })
    expect(identity).toMatch(/^desktop:[a-f0-9]{64}$/u)
    expect(identity).not.toContain('account')
    expect(read).toHaveBeenCalledTimes(2)
    expect(current).toHaveBeenCalledTimes(3)
  })
  it('rejects an account or live scope change while reading', async () => {
    const read = vi.fn().mockResolvedValueOnce(JSON.stringify(['account', 'one']))
      .mockResolvedValueOnce(JSON.stringify(['account', 'two']))
    expect(await desktopLogicalIdentity({ current: async () => true, read })).toBeUndefined()
    const current = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await desktopLogicalIdentity({ current, read: async () => JSON.stringify(['account', 'one']) }))
      .toBeUndefined()
  })
})
