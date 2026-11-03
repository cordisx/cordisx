import { expect, it } from 'vitest'
import vm from 'node:vm'
import { nativeSideChatTransforms } from '../packages/codex-adapter/src/native-side-chat-transform.js'

const source = `async function create({user,paginated,version,flag}) {
 const attached=user&&paginated&&supports('persistentSideChats',version)&&flag;
 return fork({sourceConversationId:'parent',...attached?{attachToSource:!0}:{ephemeral:!0},
 developerInstructions:['native',...attached?[]:['temporary']].join(' '),sideConversation:!0,sideConversationParentNavigationPath:'parent-route'});
}`

it('enables native attached side chats while retaining negotiated version, parent history and native instructions', async () => {
  const transform = nativeSideChatTransforms([{ url: 'app://-/side.js', source }])[0]!
  const sandbox = { supports: (_name: string, enabled: boolean) => enabled, fork: (request: unknown) => request }
  vm.runInNewContext(transform.transform(source).source, sandbox)
  const create = vm.runInNewContext('create', sandbox)
  expect(await create({ user: true, paginated: true, version: true, flag: false })).toEqual({
    sourceConversationId: 'parent',
    attachToSource: true,
    developerInstructions: 'native',
    sideConversation: true,
    sideConversationParentNavigationPath: 'parent-route',
  })
  expect(await create({ user: true, paginated: true, version: false, flag: true })).toHaveProperty('ephemeral', true)
  expect(await create({ user: true, paginated: false, version: true, flag: true })).toHaveProperty('ephemeral', true)
  expect(() => transform.transform(source + ' ')).toThrow('changed')
})

it('rejects ambiguous native creation and unrelated fork shapes', () => {
  expect(() =>
    nativeSideChatTransforms([{ url: 'app://-/side.js', source: source + source.replace('create(', 'other(') }])
  ).toThrow('ambiguous')
  expect(nativeSideChatTransforms([{ url: 'app://-/unrelated.js', source: 'const sideConversation = true;' }])).toEqual(
    [],
  )
})
