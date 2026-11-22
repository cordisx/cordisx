import { expect, it } from 'vitest'
import { harness } from './fixtures/native-submission-channel-harness.js'

it('authorizes source navigation through the current Desktop scope', async () => {
  const h = await harness()
  const scope = { ...h.draft, threadId: 'thread' }
  try {
    h.setLive(scope)
    expect(await h.channel.logicalPrevious({ scope })).toBe('source')
    expect(h.controller.logicalPrevious).toHaveBeenCalledWith(scope)
    expect(await h.channel.logicalNext({ scope })).toBe('destination')
    expect(h.controller.logicalNext).toHaveBeenCalledWith(scope)
    expect(await h.channel.logicalSourceNavigation({ scope, sessionId: 'source' })).toBe(true)
    expect(h.controller.logicalSourceNavigation).toHaveBeenCalledWith(scope, 'source')
    h.setLive({ ...scope, threadId: 'another' })
    await expect(h.channel.logicalNext({ scope })).rejects.toThrow()
    await expect(h.channel.logicalSourceNavigation({ scope, sessionId: 'source' })).rejects.toThrow()
  } finally {
    await h.installed.dispose()
  }
})

it('persists the reconciliation fence after a logical confirmation rejects with an uncertain result', async () => {
  const h = await harness()
  const scope = { ...h.draft, threadId: 'thread' }
  try {
    h.setLive(scope)
    const initial = await h.channel.selectionRead({ scope, effective: { providerId: 'openai', model: 'native' } })
    await h.channel.selectionSelect({
      scope,
      providerId: 'provider-b',
      model: 'model-b',
      mode: 'stage-send',
      expectedRevision: initial.revision,
    })
    const result = await h.channel.submissionConfirmLogical({
      scope,
      confirmationId: 'confirmation-token',
      expectedSelectionRevision: initial.revision + 1,
      mode: 'linked',
      historyConsent: 'on-demand',
      remember: 'profile',
    })
    expect(h.controller.confirmLogicalSubmission).toHaveBeenCalledWith(expect.objectContaining({ remember: 'profile' }))
    expect(result).toMatchObject({
      status: 'reject',
      reason: 'provider-switch-reconciliation-required',
      projection: { pending: { blockedReason: 'provider-switch-reconciliation-required' } },
    })
    expect((await h.channel.selectionRead({ scope })).pending.blockedReason)
      .toBe('provider-switch-reconciliation-required')
  } finally {
    await h.installed.dispose()
  }
})
