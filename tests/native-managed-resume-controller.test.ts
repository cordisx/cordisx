import { describe, expect, it } from 'vitest'
import { harness } from './fixtures/native-submission-controller-harness.js'

describe('managed-only resume admission', () => {
  it('limits proactive routing refresh to current managed providers', async () => {
    const fixture = harness({
      providerSource: id => id === 'deepseek' ? 'config' : id === 'provider-b' ? 'managed' : undefined,
    })
    await expect(fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      managedOnly: true,
    })).resolves.toEqual({ kind: 'reject', reason: 'unknown-provider' })
    expect(fixture.prepare).not.toHaveBeenCalled()
    const managed = await fixture.controller.prepareThreadResume({
      threadId: 'thread-1',
      providerId: 'provider-b',
      model: 'model-b',
      managedOnly: true,
    })
    expect(managed.kind).toBe('resume')
    if (managed.kind === 'resume') {
      await fixture.controller.completeThreadResume({
        threadId: 'thread-1',
        resumeToken: managed.resumeToken,
        succeeded: false,
      })
    }
  })
})
