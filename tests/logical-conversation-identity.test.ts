import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { logicalConversationIdentity } from '../packages/cli/src/launcher/logical-conversation-identity.js'
import { setLogicalContinuationPreference } from '../packages/cli/src/launcher/logical-continuation-preferences.js'
import type { LogicalContinuationState } from '../packages/cli/src/launcher/logical-continuation-control.js'

const source = { hostId: 'local', appId: 'codex', profileId: 'profile', sessionId: 'source' }

it('shares a root identity and preserves an earlier surface preference without merging conflicting keys', () => {
  const digest = createHash('sha256').update(JSON.stringify(source)).digest('hex')
  expect(logicalConversationIdentity(undefined, source)).toBe('logical:' + digest)
  expect(logicalConversationIdentity(undefined, {
    sessionId: source.sessionId,
    profileId: source.profileId,
    appId: source.appId,
    hostId: source.hostId,
  })).toBe('logical:' + digest)
  const state: LogicalContinuationState = { revision: 0, intents: {}, relations: {} }
  setLogicalContinuationPreference(state, { kind: 'conversation', id: 'channel-logical:' + digest }, 'fork', 0)
  expect(logicalConversationIdentity(state, source)).toBe('channel-logical:' + digest)
  const legacyScope = { kind: 'conversation' as const, id: 'desktop:' + digest }
  expect(() => setLogicalContinuationPreference(state, legacyScope, 'fresh', 0))
    .toThrow('INVALID_CONTINUATION_PREFERENCE')
  state.preferences![JSON.stringify([legacyScope.kind, legacyScope.id])] = {
    contract: 'cordisx.conversation-continuation-preference/v1',
    revision: 1,
    scope: legacyScope,
    mode: 'fresh',
  }
  expect(logicalConversationIdentity(state, source)).toBeUndefined()
})
