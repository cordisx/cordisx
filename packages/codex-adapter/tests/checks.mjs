import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { bundle, nativeAgentTaskTransforms } from '../dist/adapter.mjs'
import { resources, sharedResources } from './native-submission-structure.mjs'
import { taskExecutionSource, taskInitialSource } from './native-agent-task-source.mjs'

const context = resources => ({ appVersion: 'future/unknown', buildNumber: 'unbounded', resources, transforms: [] })
const submission = resources => bundle.modules.find(m => m.id === 'submission').analyze(context(resources)).transforms

for (const [name, fixture] of [['direct', resources], ['shared', sharedResources]]) {
  test(`admitted first-turn token survives the ${name} native normalization chain`, async () => {
    const scripts = fixture()
    const transforms = submission(scripts)
    const token = 'synthetic-admitted-send-token'
    const world = {
      __cordisxNativeSubmitHook: async () => ({ allow: true, operationToken: token }),
      updateModel: async () => true,
      createNativeThread: async () => ({ conversationResponse: { model: 'accepted-model' } }),
      normalizeWire: request => ({ input: request.input, permission: 'retained' }),
    }
    // The synthetic split fixture has the same dependency order as a native module graph.
    for (
      const script of [...scripts].sort((a, b) =>
        Number(a.source.includes('async function first')) - Number(b.source.includes('async function first'))
      )
    ) {
      const transform = transforms.find(t => t.url === script.url)
      assert(transform)
      const result = transform.transform(script.source)
      assert.equal(result.anchorMatches, 1)
      runInNewContext(result.source, world)
    }
    const operation = await world.submit({
      clearStopTurnConfirmation() {},
      submitTarget: { type: 'local' },
      isResponseInProgress: false,
      options: { input: 'synthetic' },
      conversationId: 'thread',
      defaultFollowUpSubmitAction: 'steer',
    })
    const draft = await world.draft({ context: operation, prompt: 'synthetic', serviceTier: null })
    const first = await world.first({ input: 'synthetic', config: draft.configOverrides })
    // Native task creation calls executeTurnStart directly; its main-process
    // builder keeps metadata but drops config before the intermediary sees it.
    const directTaskWire = { ...first }
    delete directTaskWire.config
    assert.equal(directTaskWire.responsesapiClientMetadata['cordisx.operation_token'], token)
    const sent = await world.dispatch({
      manager: {
        getConversation: () => ({}),
        requestClient: { getAppServerVersion: () => 'future' },
        sendRequest: async (method, request) => {
          assert.equal(method, 'turn/start')
          return request
        },
      },
      operation: { request: first },
    })
    assert.equal(sent.config['cordisx.operation_token'], token)
    assert.equal(sent.permission, 'retained')
    assert.equal(first.model, 'accepted-model')
    assert.throws(() => transforms[0].transform('changed'), /changed/u)
  })
}

test('duplicate and incomplete native structures never receive a partial submission patch', () => {
  const scripts = resources()
  assert.throws(
    () => submission([scripts[0], { ...scripts[0], url: 'app://-/assets/duplicate.js' }, scripts[1]]),
    /expected one/u,
  )
  assert.throws(() => submission([scripts[0]]), /expected one/u)
})

test('account discovery returns only the unique exported reader used by native code', () => {
  const script = {
    url: 'app://-/assets/app-shared-synthetic.js',
    source:
      'const service={accountInfo:{readAccountInfo(){return Promise.resolve({})}}};function read(){const reader=service.accountInfo;return reader.readAccountInfo()}export{service as profile};',
  }
  const account = bundle.modules.find(m => m.id === 'account')
  assert.deepEqual(account.analyze(context([script])).accountCapability, {
    module: script.url,
    exportName: 'profile',
    readerProperty: 'accountInfo',
  })
  assert.throws(
    () => account.analyze(context([script, { ...script, url: 'app://-/assets/app-shared-duplicate.js' }])),
    /expected one/u,
  )
})

test('coupled task transforms preserve the native delegated-config rejection', async () => {
  const scripts = [{ url: 'app://-/assets/initial.js', source: taskInitialSource }, {
    url: 'app://-/assets/execution.js',
    source: taskExecutionSource,
  }]
  const result = nativeAgentTaskTransforms('future', 'unknown', scripts, [])
  assert.equal(result.available, true)
  assert.equal(result.transforms.length, 2)
  assert.deepEqual(bundle.modules.find(m => m.id === 'tasks').requires, [{ id: 'submission', samePackage: true }])
  const initial = result.transforms.find(t => t.url === scripts[0].url).transform(taskInitialSource)
  const world = {}
  runInNewContext(initial.source.replace('export {create as nativeCreate};', ''), world)
  await assert.rejects(
    world.create({ config: {}, sourceThreadId: 'unmarked', target: { type: 'projectless' } }),
    /delegated config forbidden/u,
  )
})
