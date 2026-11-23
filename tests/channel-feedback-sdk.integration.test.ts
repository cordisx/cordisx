import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { it as test } from 'vitest'
import { channelFeedbackSdk } from '../packages/cli/src/launcher/channel-feedback-sdk.js'
import { ChannelStoppedFeedback } from '../packages/cli/src/launcher/channel-feedback-stopped.js'

test('real Feishu SDK sends the expected reaction and wait payloads to a local mock', async () => {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    let value
    try {
      value = body ? JSON.parse(body) : {}
    } catch {
      value = {}
    }
    const url = new URL(req.url, 'http://localhost')
    calls.push({ method: req.method, pathname: url.pathname, query: url.searchParams, body: value })
    res.setHeader('content-type', 'application/json')
    if (url.pathname.includes('tenant_access_token')) {
      res.end(JSON.stringify({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }))
    } else if (url.pathname.endsWith('/reactions')) {
      res.end(JSON.stringify({ code: 0, data: { reaction_id: `mock-${value.reaction_type.emoji_type}` } }))
    } else if (req.method === 'DELETE' && url.pathname.includes('/reactions/')) {
      res.end(JSON.stringify({ code: 0 }))
    } else if (url.pathname.endsWith('/reply') || url.pathname.endsWith('/messages')) {
      res.end(JSON.stringify({ code: 0, data: { message_id: 'om_mock_result' } }))
    } else {
      res.statusCode = 404
      res.end(JSON.stringify({ code: 404, msg: 'mock route missing' }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const sendLocal = async opts => {
    const source = new URL(opts.url, `http://127.0.0.1:${port}`)
    const target = new URL(source.pathname + source.search, `http://127.0.0.1:${port}`)
    if (opts.params) {
      for (const [key, value] of Object.entries(opts.params)) target.searchParams.set(key, String(value))
    }
    const response = await fetch(target, {
      method: opts.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(opts.data === undefined
        ? {}
        : { body: typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data) }),
    })
    return await response.json()
  }
  const localHttp = {
    request: opts => sendLocal(opts),
    get: (url, opts = {}) => sendLocal({ ...opts, url, method: 'GET' }),
    post: (url, data, opts = {}) => sendLocal({ ...opts, url, data, method: 'POST' }),
    put: (url, data, opts = {}) => sendLocal({ ...opts, url, data, method: 'PUT' }),
    patch: (url, data, opts = {}) => sendLocal({ ...opts, url, data, method: 'PATCH' }),
    delete: (url, opts = {}) => sendLocal({ ...opts, url, method: 'DELETE' }),
  }
  try {
    const require = createRequire(path.resolve('packages/cli/package.json'))
    const sdk = require('@larksuiteoapi/node-sdk')
    const channel = sdk.createLarkChannel({
      appId: 'cli_mock',
      appSecret: 'mock-secret',
      domain: sdk.Domain.Feishu,
      transport: 'websocket',
      httpInstance: localHttp,
      policy: { dmMode: 'open', requireMention: false },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    const feedback = channelFeedbackSdk(() => channel, () => true)
    const event = {
      adapterId: 'feishu',
      accountId: 'cli_mock',
      tenantId: 'tenant_mock',
      conversationId: 'oc_mock',
      kind: 'group',
      threadId: 'oc_mock',
      semantics: 'conversation',
      eventId: 'om_mock_input',
      messageId: 'om_mock_input',
    }
    const received = await feedback.feedbackReact(event, 'Get')
    const processing = await feedback.feedbackReact(event, 'OnIt')
    await assert.rejects(
      feedback.feedbackRemove({ ...event, accountId: 'other-account' }, received.reactionId),
      /NOT_OWNED/,
    )
    await feedback.feedbackRemove(event, received.reactionId)
    await feedback.feedbackWait(
      event,
      { ...event, threadId: 'om_mock_input', semantics: 'reply-chain' },
      '请稍候',
      'record-mock',
    )
    await feedback.feedbackWait(event, { ...event, semantics: 'conversation' }, '请稍候', 'record-mock')
    const reaction = calls.find(call => call.pathname.endsWith('/reactions'))
    const reply = calls.find(call => call.pathname.endsWith('/reply'))
    const create = calls.find(call => call.pathname.endsWith('/messages'))
    assert.equal(reaction?.method, 'POST')
    assert.equal(reaction?.body.reaction_type.emoji_type, 'Get')
    assert.deepEqual(
      calls.filter(call => call.pathname.includes('/reactions')).map(call => [call.method, call.pathname]),
      [
        ['POST', '/open-apis/im/v1/messages/om_mock_input/reactions'],
        ['POST', '/open-apis/im/v1/messages/om_mock_input/reactions'],
        ['DELETE', '/open-apis/im/v1/messages/om_mock_input/reactions/mock-Get'],
      ],
    )
    assert.equal(reply?.body.msg_type, 'text')
    assert.equal(JSON.parse(reply.body.content).text, '请稍候')
    assert.equal(reply.body.uuid, create.body.uuid)
    assert.equal(create?.query.get('receive_id_type'), 'chat_id')
    assert.equal(create?.body.receive_id, 'oc_mock')
    const state = {
      policy: { enabled: true, rules: [{ action: 'dispatch', effect: 'allow' }, { action: 'send', effect: 'allow' }] },
      inputs: { record: { input: { source: { event } }, feedback: { reaction: processing } } },
      jobs: { job: { id: 'job', recordId: 'record', state: 'completed', sessionId: 'session', turnId: 'turn' } },
      liveTakeovers: {},
      continuations: {},
    }
    const stopped = new ChannelStoppedFeedback({
      store: { snapshot: () => structuredClone(state), mutate: async run => run(state) },
      access: () => ({ ...feedback, generation: 'mock' }),
      turnState: async () => 'completed',
      signal: new AbortController().signal,
    })
    stopped.accepted('record', 'mock', 'DONE')
    await stopped.check('record')
    const reactionCalls = calls.filter(call => call.pathname.includes('/reactions'))
    assert.deepEqual(reactionCalls.map(call => [call.method, call.body.reaction_type?.emoji_type ?? null]), [
      ['POST', 'Get'],
      ['POST', 'OnIt'],
      ['DELETE', null],
      ['POST', 'DONE'],
      ['DELETE', null],
    ])
    assert.ok(reactionCalls[4].pathname.endsWith('/mock-OnIt'))
    stopped.dispose()
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
