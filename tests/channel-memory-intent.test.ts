import { expect, it } from 'vitest'
import { ownMemoryTopic } from '../packages/cli/src/launcher/channel-memory-intent.js'
import {
  channelCliMemoryInstructions,
  channelCliSendInstructions,
} from '../packages/cli/src/launcher/channel-cli-context.js'

it.each([
  ['我的青杉项目现在进度是什么？', '青杉'],
  ['我自己的「青杉」项目目前进展如何？', '青杉'],
  ['告诉我之前让你记住的青杉项目状态', '青杉'],
  ['我的青杉现在怎么样了？', '青杉'],
  ['What is my own Cedar project progress?', 'cedar'],
  ['What is my Cedar project progress?', 'cedar'],
])('extracts the explicitly owned subject in %s', (request, topic) => {
  expect(ownMemoryTopic(request)).toContain(topic)
})
it.each(['我的项目现在进度是什么？', '我的进度是什么？', '别人的青杉项目进度是什么？', '青杉项目进度是什么？'])(
  'does not turn a generic or unowned question into disclosure: %s',
  request => {
    expect(ownMemoryTopic(request) ?? []).toEqual([])
  },
)
it('bounds own-topic parsing and gives scoped memory commands only with a verified context token', () => {
  expect(ownMemoryTopic('我的' + '青'.repeat(16384) + '是什么')).toBeUndefined()
  const cli = { node: '/synthetic/node', entry: "/synthetic/owner's/cli.js", home: '/synthetic/home', profile: 'test' }
  const instructions = channelCliMemoryInstructions(cli, "token's").join('\n')
  expect(instructions).toContain("'/synthetic/owner'\\''s/cli.js'")
  expect(instructions).toContain("--profile 'test' --context 'token'\\''s'")
  expect(instructions).toContain('Update the same assertion')
  expect(instructions).toContain('not live task state')
  expect(instructions).toContain('widen sharing/grants')
  expect(channelCliSendInstructions(cli).join('\n')).not.toContain('scoped memory CLI')
})
