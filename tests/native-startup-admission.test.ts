import { expect, it } from 'vitest'
import { draftAction, draftScope, harness, pendingDraft } from './fixtures/native-submission-controller-harness.js'

it.each(['preparing', 'catalog-empty', 'authentication-required', 'model-unavailable'] as const)(
  'rejects native sends before side effects for %s and preserves pending selection',
  async reason => {
    const f = harness({
      pending: pendingDraft,
      startup: { availability: () => ({ available: false, reason }), wait: async () => undefined },
    })
    const result = await f.controller.prepareSubmission(draftScope, draftAction)
    expect(result).toMatchObject({ kind: 'reject', startupReason: reason })
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.clearPending).not.toHaveBeenCalled()
    expect(f.commitEffective).not.toHaveBeenCalled()
    expect(f.switchThread).not.toHaveBeenCalled()
    await f.controller.dispose()
  },
)
