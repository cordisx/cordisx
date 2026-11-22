import { expect, it } from 'vitest'
import { desktopLogicalChain, desktopLogicalNext } from '../packages/cli/src/launcher/desktop-logical-chain.js'

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

it('exposes a single committed destination only to its approving account', () => {
  const ref = (sessionId: string) => ({ hostId: 'local', appId: 'codex', profileId: 'profile', sessionId })
  const relation = {
    operationId: 'operation',
    source: ref('source'),
    destination: ref('destination'),
    logicalConversationId: 'logical',
    mode: 'linked',
  }
  const intent = { state: 'applied', actor: { principal: 'account', scope: 'desktop:codex:profile' } }
  const logical = { relations: { operation: relation }, intents: { operation: intent } }
  const next = () => desktopLogicalNext(logical as never, ref('source'), 'account')
  expect(next()).toBe('destination')
  expect(desktopLogicalNext(logical as never, ref('source'), 'other')).toBeUndefined()
  intent.state = 'unknown'
  expect(next()).toBeUndefined()
  intent.state = 'applied'
  intent.actor.scope = 'desktop:codex:other'
  expect(next()).toBeUndefined()
  intent.actor.scope = 'desktop:codex:profile'
  relation.destination.profileId = 'other'
  expect(next()).toBeUndefined()
  relation.destination.profileId = 'profile'
  relation.destination.sessionId = 'source'
  expect(next()).toBeUndefined()
  relation.destination.sessionId = 'destination'
  relation.mode = 'fresh'
  expect(next()).toBeUndefined()
  relation.mode = 'linked'
  Object.assign(logical.relations, { another: { ...relation, operationId: 'another' } })
  expect(next()).toBeUndefined()
})
