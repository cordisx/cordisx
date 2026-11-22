import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { logicalConversationIdentity } from '../packages/cli/src/launcher/logical-conversation-identity.js'
import { setLogicalContinuationPreference } from '../packages/cli/src/launcher/logical-continuation-preferences.js'

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
  const state = { revision: 0, intents: {}, relations: {} }
  setLogicalContinuationPreference(state, { kind: 'conversation', id: 'channel-logical:' + digest }, 'fork', 0)
  expect(logicalConversationIdentity(state, source)).toBe('channel-logical:' + digest)
  setLogicalContinuationPreference(state, { kind: 'conversation', id: 'desktop:' + digest }, 'fresh', 0)
  expect(logicalConversationIdentity(state, source)).toBeUndefined()
})
