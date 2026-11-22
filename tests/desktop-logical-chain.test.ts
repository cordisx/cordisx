import { expect, it } from 'vitest'
import { desktopLogicalChain } from '../packages/cli/src/launcher/desktop-logical-chain.js'

it('shows only committed links owned by the active Desktop account', () => {
  const ref = (sessionId: string) => ({ hostId: 'local', appId: 'codex', profileId: 'profile', sessionId })
  const link = (operationId: string, source: string, destination: string) => ({
    operationId,
    source: ref(source),
    destination: ref(destination),
    logicalConversationId: 'logical',
    mode: 'linked',
  })
  const logical = {
    relations: { a: link('a', 'one', 'two'), b: link('b', 'two', 'three') },
    intents: {
      a: { state: 'applied', actor: { principal: 'other', scope: 'desktop:codex:profile' } },
      b: { state: 'applied', actor: { principal: 'current', scope: 'desktop:codex:profile' } },
    },
  }
  expect(desktopLogicalChain(logical as never, ref('three'), 'current')).toEqual({
    links: [{ source: 'two', destination: 'three', mode: 'linked' }],
    truncated: true,
  })
  logical.intents.a.actor.principal = 'current'
  expect(desktopLogicalChain(logical as never, ref('three'), 'current')).toEqual({
    links: [
      { source: 'one', destination: 'two', mode: 'linked' },
      { source: 'two', destination: 'three', mode: 'linked' },
    ],
    truncated: false,
  })
  logical.intents.b.state = 'unknown'
  expect(desktopLogicalChain(logical as never, ref('three'), 'current')).toEqual({ links: [], truncated: true })
})
