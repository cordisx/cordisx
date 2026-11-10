import { describe, expect, it } from 'vitest'
import { harness } from './fixtures/native-submission-channel-harness.js'

describe('session selection reconciliation', () => {
  it('refreshes an existing composer scope after another scope changes the same thread', async () => {
    const h = await harness()
    const main = { ...h.draft, composerId: 'main', threadId: 'thread' }
    const side = { ...h.draft, composerId: 'side', threadId: 'thread' }
    try {
      h.setLive(main)
      const initial = await h.channel.selectionRead({ scope: main, effective: { providerId: 'openai', model: 'old' } })
      h.setLive(side)
      const other = await h.channel.selectionRead({ scope: side, effective: { providerId: 'openai', model: 'old' } })
      await h.channel.selectionSelect({
        scope: side,
        providerId: 'openai',
        model: 'new',
        expectedRevision: other.revision,
      })
      h.setLive(main)
      const refreshed = await h.channel.selectionRead({
        scope: main,
        effective: { providerId: 'openai', model: 'old' },
      })
      expect(refreshed.effective).toEqual({ providerId: 'openai', model: 'new' })
      expect(refreshed.revision).toBeGreaterThan(initial.revision)
      const same = await h.channel.selectionRead({ scope: main })
      expect(same.revision).toBe(refreshed.revision)
    } finally {
      await h.installed.dispose()
    }
  })
})
