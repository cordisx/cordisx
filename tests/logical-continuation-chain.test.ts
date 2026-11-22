import { expect, it } from 'vitest'
import { logicalContinuationChain } from '../packages/cli/src/launcher/logical-continuation-chain.js'

it('returns only confirmed boundaries in order and refuses ambiguous or cross-profile ancestors', () => {
  const ref = (sessionId: string) => ({ hostId: 'local', appId: 'codex', profileId: 'fixture', sessionId })
  const first = {
    operationId: 'first',
    logicalConversationId: 'logical',
    source: ref('a'),
    destination: ref('b'),
    mode: 'linked',
    target: { providerId: 'one', model: 'model' },
    historyCategories: ['user-text'],
    handoff: 'none',
  }
  const second = {
    operationId: 'second',
    logicalConversationId: 'logical',
    source: ref('b'),
    destination: ref('c'),
    mode: 'fork',
    target: { providerId: 'two', model: 'model' },
  }
  const state = {
    logicalContinuations: {
      relations: { first, second },
      intents: {
        first: { state: 'applied', actor: { principal: 'private' } },
        second: { state: 'applied' },
      },
    },
  }
  const store = { snapshot: () => structuredClone(state) } as never
  const result = logicalContinuationChain(store, 'codex', 'fixture', { sessionId: 'c' })
  expect(result.links).toEqual([
    {
      source: 'a',
      destination: 'b',
      mode: 'linked',
      target: first.target,
      historyCategories: ['user-text'],
      handoff: 'none',
    },
    { source: 'b', destination: 'c', mode: 'fork', target: second.target },
  ])
  expect(JSON.stringify(result)).not.toContain('private')
  expect(logicalContinuationChain(store, 'codex', 'other', { sessionId: 'c' }).links).toEqual([])
  expect(() => logicalContinuationChain(store, 'codex', 'fixture', { sessionId: 'c', actor: 'private' }))
    .toThrow('INVALID_REQUEST')
  first.source.profileId = 'other'
  expect(() => logicalContinuationChain(store, 'codex', 'fixture', { sessionId: 'c' }))
    .toThrow('LOGICAL_CHAIN_UNAVAILABLE')
  first.source.profileId = 'fixture'
  first.source.sessionId = 'c'
  expect(() => logicalContinuationChain(store, 'codex', 'fixture', { sessionId: 'c' }))
    .toThrow('LOGICAL_CHAIN_UNAVAILABLE')
  first.source.sessionId = 'a'
  state.logicalContinuations.relations = { first, second, duplicate: { ...second, operationId: 'duplicate' } } as never
  expect(() => logicalContinuationChain(store, 'codex', 'fixture', { sessionId: 'c' }))
    .toThrow('LOGICAL_CHAIN_UNAVAILABLE')
})
