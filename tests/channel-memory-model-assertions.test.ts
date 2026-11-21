import { expect, it } from 'vitest'
import { scenarioChecks } from '../packages/cli/scripts/channel-memory-model-assertions.mjs'

it('answer-only hallucination cannot pass real-model scenario checks', () => {
  const scenario = { turns: ['save', 'recall'], facts: ['CODE-42'] }
  const turns = [{ exit: 0, answer: 'Saved' }, { exit: 0, answer: 'CODE-42' }]
  expect(scenarioChecks(scenario, turns, [], []).factsFromRead).toBe(false)
  expect(scenarioChecks(scenario, turns, [], []).actualSave).toBe(false)
})

it('manual delivery requires a sent receipt, not a merely ok operation', () => {
  const scenario = {
    id: 'manual-auto-style',
    outbound: true,
    turns: ['save', 'manual', 'final'],
    facts: ['OUTBOUND-82'],
  }
  const turns = [{ exit: 0, answer: '' }, { exit: 0, answer: '' }, { exit: 0, answer: '发布代码 OUTBOUND-82' }]
  const event = {
    turn: 1,
    input: { action: 'send', text: '发布代码 OUTBOUND-82' },
    result: { status: 'ok', deliveryState: 'not-found' },
  }
  expect(scenarioChecks(scenario, turns, [event], []).outboundGenerated).toBe(false)
  expect(
    scenarioChecks(scenario, turns, [{ ...event, result: { status: 'ok', deliveryState: 'sent' } }], [])
      .outboundGenerated,
  ).toBe(true)
})

it('save and read events plus actual record and answer facts pass independently of wording', () => {
  const scenario = { turns: ['save', 'recall'], facts: ['CODE-42'], revision: 2, forbidden: ['OLD-10'] }
  const turns = [{ exit: 0, answer: 'Done' }, { exit: 0, answer: 'The current value is CODE-42.' }]
  const events = [
    { turn: 0, input: { action: 'remember' }, result: { status: 'ok' } },
    { turn: 1, input: { action: 'get' }, result: { status: 'ok', result: { summary: 'CODE-42' } } },
  ]
  expect(Object.values(scenarioChecks(scenario, turns, events, [{ revision: 2 }])).every(Boolean)).toBe(true)
  expect(scenarioChecks(scenario, turns, events, [{ revision: 1 }]).revision).toBe(false)
  expect(
    scenarioChecks(scenario, [{ exit: 0, answer: 'Done' }, { exit: 0, answer: 'OLD-10 CODE-42' }], events, [{
      revision: 2,
    }]).noObsoleteFacts,
  ).toBe(false)
})
