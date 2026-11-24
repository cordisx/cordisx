import { expect, it } from 'vitest'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { parseChannelModelPriority } from '../packages/cli/src/launcher/channel-model-priority.js'
import { fixture } from './helpers/channel-conversation-fixture.js'

it('bounds the ordered priority and rejects duplicate or sensitive fields', () => {
  const candidate = { providerId: 'provider', model: 'model' }
  expect(parseChannelModelPriority({ revision: 0, candidates: [candidate] }).candidates).toEqual([candidate])
  for (
    const value of [
      { revision: 0, candidates: [candidate, candidate] },
      { revision: 0, candidates: [{ ...candidate, apiKey: 'secret' }] },
      { revision: 0, candidates: Array.from({ length: 9 }, (_, index) => ({ ...candidate, model: String(index) })) },
      { revision: -1, candidates: [] },
    ]
  ) expect(() => parseChannelModelPriority(value)).toThrow()
})

it('allows only local revision-checked replacement and preserves the previous value on conflict', async () => {
  const f = await fixture()
  const tools = new ChannelConversationTools(() => f.access, f.consumer)
  const value = { expectedRevision: 0, candidates: [{ providerId: 'provider', model: 'model' }] }
  expect(await tools.callLocal('model-priority-set', value, { 'openai/threadId': 'agent' }))
    .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
  expect(await tools.callLocal('model-priority-set', value)).toMatchObject({ status: 'ok', revision: 1 })
  expect(await tools.callLocal('model-priority-set', value)).toMatchObject({
    status: 'rejected',
    code: 'REVISION_CONFLICT',
  })
  expect(await tools.callLocal('model-priority', {})).toMatchObject({
    status: 'ok',
    revision: 1,
    candidates: value.candidates,
  })
  expect(
    await tools.callLocal('failure-notices-set', { expectedRevision: 0, enabled: false }, {
      'openai/threadId': 'agent',
    }),
  )
    .toMatchObject({ status: 'rejected', code: 'LOCAL_USER_REQUIRED' })
  expect(await tools.callLocal('failure-notices-set', { expectedRevision: 0, enabled: false }))
    .toMatchObject({ status: 'ok', revision: 1, enabled: false })
  expect(await tools.callLocal('failure-notices-set', { expectedRevision: 0, enabled: true }))
    .toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT' })
  tools.dispose()
})
