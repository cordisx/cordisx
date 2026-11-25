import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChannelEventRef, ChannelThreadRef } from '@cordisx/channel-runtime'
import { ChannelOutboundRpc } from './channel-outbound-rpc.js'
import {
  CHANNEL_CONVERSATION_POLICY_INITIAL,
  type ChannelConversationPolicy,
  channelPolicyAllows,
} from './channel-conversation-policy.js'
import { type ChannelConversationAccess, ChannelConversationTools } from './channel-conversation-tools.js'

const account = { adapterId: 'feishu', accountId: 'test', tenantId: 'tenant' }
const source: ChannelEventRef = {
  ...account,
  conversationId: 'oc_source',
  kind: 'group',
  threadId: 'oc_source',
  semantics: 'conversation',
  eventId: 'event',
  actor: { ...account, userId: 'actor' },
}
const bytes = Buffer.from('hello')
const begin = {
  action: 'begin',
  account,
  target: { id: 'oc_target', kind: 'group' },
  operationId: 'prepare',
  type: 'file',
  mediaType: 'application/octet-stream',
  name: 'sample.bin',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function fixture() {
  const outbound = new ChannelOutboundRpc()
  const caller = { source, threadId: 'session', turnId: 'turn' }
  const commandAllowed = vi.fn(() => true), sendAllowed = vi.fn((_target: ChannelThreadRef) => true)
  const consumer = {
    agentAccess: {
      hasPreparation: () => false,
      preparation: () => false,
      caller: (metadata: unknown) =>
        (metadata as Record<string, unknown>)?.['cordisx/channelContext'] === 'valid' ? caller : undefined,
      source: () => source,
    },
    taskSettings: { isBound: () => false },
    commandAllowed,
    sendAllowed,
    trackProgressDelivery: vi.fn(),
    claimDeliveryIds: () => () => {},
    profileLogicalOwner: () => ({ store: { snapshot: () => ({ jobs: {} }) } }),
  }
  const receipts = new Map<string, { state: string }>()
  const notifyOnce = vi.fn(async (_notification: unknown, _caller: unknown, id: string) => {
    receipts.set(id, { state: 'sent' })
    return { deliveryId: id }
  })
  const access = {
    generation: 'generation',
    outbound,
    accounts: () => [{ ref: account, state: 'ready' }],
    runtime: {
      notifyOnce,
      deliverySnapshot: (id: string) => receipts.get(id),
      outboundCapabilities: vi.fn(async () => ({
        types: ['text', 'image', 'audio', 'video', 'file', 'card', 'richtext'],
        maxMediaBytes: 30000000,
      })),
      outboundCapabilitiesV2: vi.fn(async () => ({ richtext: { paragraphs: true, mentions: true } })),
      validateMentionContent: vi.fn(async () => {}),
    },
    drain: vi.fn(async () => {}),
  } as unknown as ChannelConversationAccess
  let current: ChannelConversationAccess | undefined = access
  const tools = new ChannelConversationTools(() => current, consumer as never)
  cleanups.push(() => {
    tools.dispose()
    outbound.dispose()
  })
  const metadata = { 'cordisx/channelContext': 'valid' }
  const call = (input: unknown, meta: unknown = metadata) => tools.call('media-prepare', input, meta)
  return {
    outbound,
    tools,
    call,
    caller,
    commandAllowed,
    sendAllowed,
    notifyOnce,
    access,
    metadata,
    clear: () => {
      current = undefined
    },
  }
}

async function prepare(f: ReturnType<typeof fixture>) {
  const started = await f.call(begin) as { uploadId: string }
  expect(started).toMatchObject({ status: 'ok' })
  expect(
    await f.call({ action: 'chunk', uploadId: started.uploadId, offset: 0, bytesBase64: bytes.toString('base64') }),
  ).toMatchObject({ status: 'ok' })
  const committed = await f.call({ action: 'commit', uploadId: started.uploadId }) as { media: { handle: string } }
  expect(committed).toMatchObject({ status: 'ok', media: { filename: 'sample.bin' } })
  return { ...started, ...committed }
}

it('prepares through tools and passes verified typed content to runtime', async () => {
  const f = fixture(), result = await prepare(f)
  const send = {
    account,
    target: begin.target,
    operationId: 'send',
    payload: { type: 'file', handle: result.media.handle },
  }
  expect(await f.tools.call('send', send, f.metadata)).toMatchObject({ status: 'ok' })
  expect(f.notifyOnce).toHaveBeenCalledWith(
    expect.objectContaining({
      text: '',
      content: expect.objectContaining({
        type: 'file',
        handle: result.media.handle,
      }),
    }),
    expect.anything(),
    expect.any(String),
  )
  expect(f.commandAllowed).not.toHaveBeenCalled()
  expect(f.sendAllowed).toHaveBeenCalledTimes(8)
  expect(f.sendAllowed).toHaveBeenCalledWith(source)
  expect(f.sendAllowed).toHaveBeenCalledWith(
    expect.objectContaining({ actor: source.actor, conversationId: 'oc_target' }),
  )
  expect(await f.outbound.authority.resolve(result.media.handle, f.sendAllowed.mock.calls[1]![0]!, 5)).toEqual(
    Uint8Array.from(bytes),
  )
})

it.each(['begin', 'chunk', 'commit', 'send'])('rechecks source and target policy at %s', async action => {
  const f = fixture()
  const started = action === 'begin' ? undefined : await f.call(begin) as { uploadId: string }
  if (action === 'commit') {
    await f.call({ action: 'chunk', uploadId: started!.uploadId, offset: 0, bytesBase64: bytes.toString('base64') })
  }
  const sealed = action === 'send' ? await prepare(f) : undefined
  f.sendAllowed.mockReturnValue(false)
  const request = action === 'begin'
    ? begin
    : {
      action,
      uploadId: started!.uploadId,
      ...(action === 'chunk' ? { offset: 0, bytesBase64: bytes.toString('base64') } : {}),
    }
  const result = action === 'send'
    ? await f.tools.call('send', {
      account,
      target: begin.target,
      operationId: 'send',
      payload: { type: 'file', handle: sealed!.media.handle },
    }, f.metadata)
    : await f.call(request)
  expect(result).toMatchObject({ status: 'rejected', code: 'CHANNEL_POLICY_DENIED' })
  f.sendAllowed.mockReturnValue(true)
  expect(f.notifyOnce).not.toHaveBeenCalled()
})

it('rejects forged context, changed caller principal and mismatched media type/target before effects', async () => {
  const f = fixture(), result = await prepare(f)
  expect(await f.call({ action: 'commit', uploadId: result.uploadId }, { 'cordisx/channelContext': 'forged' }))
    .toMatchObject({ code: 'CHANNEL_CONTEXT_UNAVAILABLE' })
  f.caller.turnId = 'other-turn'
  expect(await f.call({ action: 'commit', uploadId: result.uploadId })).toMatchObject({ code: 'MEDIA_SOURCE_DENIED' })
  f.caller.turnId = 'turn'
  for (
    const patch of [
      {
        targets: [begin.target, { id: 'oc_other', kind: 'group' }],
        payload: { type: 'file', handle: result.media.handle },
      },
      { targets: [begin.target], payload: { type: 'video', handle: result.media.handle } },
    ]
  ) {
    expect(await f.tools.call('send-many', { account, operationId: 'send', ...patch }, f.metadata)).toMatchObject({
      status: 'rejected',
    })
  }
  expect(f.notifyOnce).not.toHaveBeenCalled()
})

it('does not continue after a bad chunk and rejects ambiguous typed sends or fallback', async () => {
  const f = fixture(), started = await f.call(begin) as { uploadId: string }
  expect(await f.call({ action: 'chunk', uploadId: started.uploadId, offset: 0, bytesBase64: 'Zh==' })).toMatchObject({
    code: 'MEDIA_CHUNK_INVALID',
  })
  expect(await f.call({ action: 'commit', uploadId: started.uploadId })).toMatchObject({ code: 'MEDIA_SOURCE_DENIED' })
  for (
    const patch of [
      { text: 'ambiguous', payload: { type: 'text', text: 'typed' } },
      { content: { type: 'text', text: 'one' }, payload: { type: 'text', text: 'two' } },
      { payload: { type: 'text', text: 'typed' }, fallback: { type: 'text', text: 'fallback' } },
    ]
  ) {
    expect(await f.tools.call('send', { account, target: begin.target, operationId: 'send', ...patch }, f.metadata))
      .toMatchObject({ status: 'rejected' })
  }
  expect(f.notifyOnce).not.toHaveBeenCalled()
})

it.each(['text', 'card', 'richtext'])('forwards typed %s without interpreting adapter content', async type => {
  const f = fixture()
  const content = type === 'text'
    ? { type, text: 'hello' }
    : type === 'card'
    ? { type, title: 'title', body: 'body' }
    : { type, blocks: [{ text: 'hello', style: 'strong' }] }
  expect(await f.tools.call('send', { account, target: begin.target, operationId: 'typed', content }, f.metadata))
    .toMatchObject({ status: 'ok' })
  expect(f.notifyOnce).toHaveBeenCalledWith(expect.objectContaining({ content }), expect.anything(), expect.any(String))
})

it('validates and forwards explicit protocol fallback without silently downgrading', async () => {
  const f = fixture()
  for (const fallback of [{ mode: 'reject' }, { mode: 'text', text: 'explicit fallback' }]) {
    const content = { type: 'card', title: 'title', body: 'body' }
    expect(
      await f.tools.call('send', {
        account,
        target: begin.target,
        operationId: JSON.stringify(fallback),
        content,
        fallback,
      }, f.metadata),
    ).toMatchObject({ status: 'ok' })
    expect(f.notifyOnce).toHaveBeenLastCalledWith(
      expect.objectContaining({ content, fallback }),
      expect.anything(),
      expect.any(String),
    )
  }
  f.notifyOnce.mockClear()
  for (
    const fallback of ['reject', { mode: 'text', text: '' }, { mode: 'reject', text: 'extra' }, {
      type: 'text',
      text: 'old',
    }]
  ) {
    expect(
      await f.tools.call('send', {
        account,
        target: begin.target,
        operationId: 'bad',
        content: { type: 'text', text: 'hello' },
        fallback,
      }, f.metadata),
    ).toMatchObject({ status: 'rejected' })
  }
  expect(f.notifyOnce).not.toHaveBeenCalled()
})

it('keeps receipt and existing-operation retries independent of expired handles, but blocks new sends', async () => {
  const f = fixture(), prepared = await prepare(f)
  const send = {
    account,
    target: begin.target,
    operationId: 'send',
    content: { type: 'file', handle: prepared.media.handle },
  }
  expect(await f.tools.call('send', send, f.metadata)).toMatchObject({ status: 'ok' })
  const capabilities = vi.spyOn(f.access.runtime, 'outboundCapabilities').mockRejectedValue(
    new Error('CAPABILITIES_CHANGED'),
  )
  const descriptor = vi.spyOn(f.outbound.store, 'descriptor').mockImplementation(() => {
    throw new Error('MEDIA_SOURCE_DENIED')
  })
  expect(await f.tools.call('receipt', { account, operationId: 'send' }, f.metadata)).toMatchObject({
    status: 'ok',
    receipt: { state: 'sent' },
  })
  expect(await f.tools.call('send', send, f.metadata)).toMatchObject({ status: 'ok' })
  expect(descriptor).not.toHaveBeenCalled()
  expect(capabilities).not.toHaveBeenCalled()
  expect(await f.tools.call('send', { ...send, operationId: 'new' }, f.metadata)).toMatchObject({
    status: 'rejected',
    code: 'MEDIA_SOURCE_DENIED',
  })
})

it('accepts canonical filename/format and rejects inconsistent aliases', async () => {
  const f = fixture()
  const { name: _name, mediaType: _mediaType, ...canonical } = begin
  expect(await f.call({ ...canonical, filename: 'sample.bin', format: 'binary' })).toMatchObject({ status: 'ok' })
  expect(await f.call({ ...begin, filename: 'different.bin' })).toMatchObject({ status: 'rejected' })
  expect(await f.call({ ...begin, format: 'pdf' })).toMatchObject({ status: 'rejected' })
})

it('rechecks ready account on chunks and commits and rejects unavailable service access', async () => {
  const f = fixture(), started = await f.call(begin) as { uploadId: string }
  const accounts = vi.spyOn(f.access, 'accounts').mockReturnValue([{ ref: account, state: 'disabled' }])
  for (const action of ['chunk', 'commit']) {
    expect(
      await f.call({
        action,
        uploadId: started.uploadId,
        ...(action === 'chunk' ? { offset: 0, bytesBase64: bytes.toString('base64') } : {}),
      }),
    ).toMatchObject({ code: 'CONNECTION_NOT_READY' })
  }
  accounts.mockRestore()
  f.clear()
  expect(await f.call(begin)).toMatchObject({ status: 'unavailable' })
})

it('rejects aggregate inline content size before any batch effect', async () => {
  const f = fixture()
  const content = {
    type: 'richtext',
    blocks: [{
      type: 'paragraph',
      nodes: Array.from({ length: 128 }, () => ({ type: 'text', text: 'x'.repeat(4096), style: 'plain' })),
    }],
  }
  expect(
    await f.tools.call(
      'send-many',
      { account, targets: [begin.target], operationId: 'oversized', content },
      f.metadata,
    ),
  ).toMatchObject({ status: 'rejected', code: 'INVALID_CHANNEL_PAYLOAD' })
  expect(f.notifyOnce).not.toHaveBeenCalled()
})

it('preflights every mention identity before any batch effect and never falls back on identity denial', async () => {
  const f = fixture()
  const verify = vi.spyOn(f.access.runtime, 'validateMentionContent')
  verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('CHANNEL_MENTION_UNVERIFIED'))
  const request = {
    account,
    targets: [begin.target, { id: 'oc_other', kind: 'group' }],
    operationId: 'mention-batch',
    content: {
      type: 'richtext',
      blocks: [{
        type: 'paragraph',
        nodes: [{ type: 'mention', userId: 'ou_verified' }, { type: 'text', text: ' review', style: 'plain' }],
      }],
    },
    fallback: { mode: 'text', text: 'explicit fallback' },
  }
  expect(await f.tools.call('send-many', request, f.metadata)).toMatchObject({ code: 'CHANNEL_MENTION_UNVERIFIED' })
  expect(verify).toHaveBeenCalledTimes(2)
  expect(f.notifyOnce).not.toHaveBeenCalled()
  verify.mockResolvedValue(undefined)
  vi.spyOn(f.access.runtime, 'outboundCapabilitiesV2').mockResolvedValue(
    { richtext: { paragraphs: true, mentions: false } } as never,
  )
  expect(await f.tools.call('send-many', { ...request, fallback: { mode: 'reject' } }, f.metadata)).toMatchObject({
    code: 'CHANNEL_OUTBOUND_TYPE_UNSUPPORTED',
  })
  expect(f.notifyOnce).not.toHaveBeenCalled()
})

it('preflights every typed batch capability before enqueueing and only accepts explicit fallback', async () => {
  const f = fixture()
  const capabilities = vi.spyOn(f.access.runtime, 'outboundCapabilities')
  capabilities.mockResolvedValueOnce({ types: ['card', 'text'] } as never)
    .mockResolvedValueOnce({ types: ['text'] } as never)
  const request = {
    account,
    targets: [begin.target, { id: 'oc_other', kind: 'group' }],
    operationId: 'batch',
    content: { type: 'card', title: 'title', body: 'body' },
  }
  expect(await f.tools.call('send-many', request, f.metadata)).toMatchObject({
    status: 'rejected',
    code: 'CHANNEL_OUTBOUND_TYPE_UNSUPPORTED',
  })
  expect(f.notifyOnce).not.toHaveBeenCalled()
  expect(capabilities).toHaveBeenCalledTimes(2)
  capabilities.mockResolvedValue({ types: ['text'] } as never)
  expect(await f.tools.call('send-many', { ...request, fallback: { mode: 'text', text: 'explicit' } }, f.metadata))
    .toMatchObject({ status: 'ok' })
  expect(f.notifyOnce).toHaveBeenCalledTimes(2)
  f.notifyOnce.mockClear()
  capabilities.mockRejectedValueOnce(new Error('CHANNEL_POLICY_DENIED'))
  expect(await f.tools.call('send-many', { ...request, operationId: 'new-denied-batch' }, f.metadata)).toMatchObject({
    code: 'CHANNEL_POLICY_DENIED',
  })
  expect(f.notifyOnce).not.toHaveBeenCalled()
})

it('rejects a later media target byte limit before any batch enqueue', async () => {
  const f = fixture(), prepared = await prepare(f)
  const capabilities = vi.spyOn(f.access.runtime, 'outboundCapabilities')
  capabilities.mockResolvedValueOnce({ types: ['file'], maxMediaBytes: 5 } as never)
    .mockResolvedValueOnce({ types: ['file'], maxMediaBytes: 4 } as never)
  expect(
    await f.tools.call('send-many', {
      account,
      targets: [begin.target, begin.target],
      operationId: 'bytes-batch',
      content: { type: 'file', handle: prepared.media.handle },
    }, f.metadata),
  ).toMatchObject({ status: 'rejected', code: 'MEDIA_SIZE_DENIED' })
  expect(f.notifyOnce).not.toHaveBeenCalled()
  expect(capabilities).toHaveBeenCalledTimes(2)
})

it('preserves target send-policy defaults across source accounts without requiring command grants', async () => {
  const f = fixture()
  f.caller.source = { ...source, accountId: 'other-source', actor: { ...source.actor!, accountId: 'other-source' } }
  let policy: ChannelConversationPolicy = { ...CHANNEL_CONVERSATION_POLICY_INITIAL, enabled: true }
  f.commandAllowed.mockImplementation(() => channelPolicyAllows(policy, 'command', f.caller.source, 'send'))
  f.sendAllowed.mockImplementation(event => channelPolicyAllows(policy, 'send', event as ChannelEventRef))
  expect(channelPolicyAllows(policy, 'command', f.caller.source, 'send')).toBe(false)
  expect(await f.call(begin)).toMatchObject({ status: 'ok' })
  expect(
    await f.tools.call(
      'send',
      { account, target: begin.target, operationId: 'plain', text: 'ordinary source send' },
      f.metadata,
    ),
  ).toMatchObject({ status: 'ok' })
  expect(f.commandAllowed).not.toHaveBeenCalled()
  policy = { ...policy, rules: [{ id: 'deny-target', action: 'send', effect: 'deny', accountId: account.accountId }] }
  expect(await f.call({ ...begin, operationId: 'denied' })).toMatchObject({ code: 'CHANNEL_POLICY_DENIED' })
  policy = { ...policy, rules: [{ id: 'deny-source', action: 'send', effect: 'deny', accountId: 'other-source' }] }
  expect(await f.call({ ...begin, operationId: 'source-denied' })).toMatchObject({ code: 'CHANNEL_POLICY_DENIED' })
  expect(
    await f.tools.call(
      'send',
      { account, target: begin.target, operationId: 'source-denied', text: 'blocked' },
      f.metadata,
    ),
  ).toMatchObject({ code: 'CHANNEL_POLICY_DENIED' })
  policy = { ...policy, rules: [{ id: 'deny-other', action: 'send', effect: 'deny', accountId: 'unrelated' }] }
  expect(await f.call({ ...begin, operationId: 'allowed' })).toMatchObject({ status: 'ok' })
  expect(f.sendAllowed).toHaveBeenLastCalledWith(
    expect.objectContaining({ accountId: account.accountId, actor: f.caller.source.actor }),
  )
})
