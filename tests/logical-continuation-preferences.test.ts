import { describe, expect, it } from 'vitest'
import { parseLogicalContinuationState } from '../packages/cli/src/launcher/logical-continuation-control.js'
import {
  logicalPreferenceRevision,
  resolveLogicalContinuationPreference,
  setLogicalContinuationPreference,
} from '../packages/cli/src/launcher/logical-continuation-preferences.js'

describe('logical continuation mode preferences', () => {
  it('uses the narrowest explicit mode without granting transfer consent and fences stale resets', () => {
    const state = { revision: 0, intents: {}, relations: {} }
    const profile = { kind: 'profile' as const, id: 'profile' },
      conversation = { kind: 'conversation' as const, id: 'logical' }
    expect(resolveLogicalContinuationPreference(state, { profileId: 'profile' })).toBeUndefined()
    setLogicalContinuationPreference(state, profile, 'linked', 0)
    expect(() => setLogicalContinuationPreference(state, conversation, 'fresh', 0))
      .toThrow('INVALID_CONTINUATION_PREFERENCE')
    setLogicalContinuationPreference(state, conversation, 'fork', 0)
    expect(resolveLogicalContinuationPreference(state, { profileId: 'profile', conversationId: 'logical' })?.mode).toBe(
      'fork',
    )
    setLogicalContinuationPreference(state, conversation, null, 1)
    expect(resolveLogicalContinuationPreference(state, { profileId: 'profile', conversationId: 'logical' })?.mode).toBe(
      'linked',
    )
    expect(logicalPreferenceRevision(state, conversation)).toBe(2)
    expect(() => setLogicalContinuationPreference(state, conversation, 'fork', 0)).toThrow('REVISION_CONFLICT')
    expect(parseLogicalContinuationState(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })
  it('retains a legacy fresh preference for inspection without rewriting it', () => {
    const scope = { kind: 'profile' as const, id: 'profile' }, key = JSON.stringify([scope.kind, scope.id])
    const state = {
      revision: 0,
      intents: {},
      relations: {},
      preferences: {
        [key]: {
          contract: 'cordisx.conversation-continuation-preference/v1' as const,
          revision: 1,
          scope,
          mode: 'fresh' as const,
        },
      },
      preferenceRevisions: { [key]: 1 },
    }
    expect(parseLogicalContinuationState(state)).toEqual(state)
    expect(resolveLogicalContinuationPreference(state, { profileId: 'profile' })?.mode).toBe('fresh')
  })
})
