import { describe, expect, it } from 'vitest'
import { channelCliHelp } from '../packages/cli/src/cli/channel-command-help.js'
import {
  prepareChannelSendInput,
  validateChannelMediaPrepareInput,
  validateChannelSendFallback,
  validateChannelSendPayload,
} from '../packages/cli/src/cli/channel-send-payload.js'

describe('configured Channel send payload boundary', () => {
  it.each(['send', 'send-many'])('documents richtext preference without changing text semantics: %s', operation => {
    const help = channelCliHelp(operation)
    expect(help).toContain('Prefer richtext for ordinary prose, progress and results')
    expect(help).toContain('verbatim original text, an explicit plain-text request, or Host/platform compatibility')
    expect(help).toContain('plain-text wire semantics')
    expect(help).toContain('type:"richtext",blocks:[{text:"Message",style:"plain"}]')
    expect(help).toContain('never blindly resend')
  })

  it('validates bounded bytes prepare without treating names, paths or claimed grants as authority', () => {
    const input = {
      account: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant' },
      target: { id: 'oc_chat', kind: 'group' },
      operationId: 'prepare-once',
      type: 'image',
      mediaType: 'image/png',
      name: 'picture.png',
      bytesBase64: Buffer.from('bytes').toString('base64'),
    }
    expect(validateChannelMediaPrepareInput(input)).toEqual(input)
    for (
      const extra of [
        { path: '/tmp/private' },
        { actor: 'admin' },
        { context: 'claimed' },
        { target: { ...input.target, path: '/tmp/private' } },
        { bytesBase64: 'YQ=' },
        { bytesBase64: 'YR==' },
        { bytesBase64: 'data:image/png;base64,YQ==' },
        { bytesBase64: Buffer.alloc(1_048_577).toString('base64') },
        { name: '../private' },
        { type: 'card' },
      ]
    ) {
      expect(() => validateChannelMediaPrepareInput({ ...input, ...extra })).toThrow('INVALID_CHANNEL_PAYLOAD')
    }
  })
  it('preserves legacy text input and normalizes typed text without changing scope', () => {
    const legacy = { account: { adapterId: 'feishu' }, target: { id: 'oc_chat' }, text: 'hello', operationId: 'once' }
    expect(prepareChannelSendInput(legacy)).toBe(legacy)
    const { text, ...scope } = legacy
    expect(prepareChannelSendInput({ ...scope, payload: { type: 'text', text } })).toEqual(legacy)
    expect(prepareChannelSendInput({ targets: [{ id: 'one' }, { id: 'two' }], payload: { type: 'text', text } }))
      .toEqual({ targets: [{ id: 'one' }, { id: 'two' }], text })
  })

  it('accepts only a versioned, single-target terminal intent', () => {
    const terminal = {
      contract: 'cordisx.channel-terminal-intent/v1',
      schemaVersion: 1,
      inputOperationId: 'channel:one',
    }
    const target = { id: 'oc_chat', kind: 'group' }
    const request = { target, operationId: 'send-once', content: { type: 'text', text: 'answer' }, terminal }
    expect(prepareChannelSendInput(request)).toEqual(request)
    for (
      const invalid of [
        null,
        { ...terminal, schemaVersion: 2 },
        { ...terminal, inputOperationId: '' },
        { ...terminal, inputOperationId: 'bad\nvalue' },
        { ...terminal, claimedSent: true },
      ]
    ) {
      expect(() => prepareChannelSendInput({ ...request, terminal: invalid })).toThrow('INVALID_CHANNEL_PAYLOAD')
    }
    expect(() => prepareChannelSendInput({ ...request, target: undefined, targets: [target] }))
      .toThrow('INVALID_CHANNEL_PAYLOAD')
    expect(channelCliHelp('send')).toContain('cordisx.channel-terminal-intent/v1')
    expect(channelCliHelp('send-many')).not.toContain('cordisx.channel-terminal-intent/v1')
  })

  it.each(['image', 'audio', 'video', 'file'] as const)(
    'validates %s opaque handles but does not enable sending',
    type => {
      const prefix = 'media'
      const payload = { type, handle: `${prefix}:host-issued_id` }
      expect(validateChannelSendPayload(payload)).toEqual(payload)
      expect(prepareChannelSendInput({ payload })).toEqual({ payload })
      for (
        const handle of ['/tmp/private', 'file:///tmp/private', 'https://example.com', 'data:base64', 'media:../secret']
      ) {
        expect(() => validateChannelSendPayload({ type, handle })).toThrow('INVALID_CHANNEL_PAYLOAD')
      }
      expect(() => validateChannelSendPayload({ ...payload, path: '/tmp/private' })).toThrow('INVALID_CHANNEL_PAYLOAD')
    },
  )

  it('bounds richtext without accepting raw platform blocks or downgrading to text', () => {
    const payload = { type: 'richtext', blocks: [{ style: 'plain', text: 'hello' }] }
    expect(validateChannelSendPayload(payload)).toEqual(payload)
    expect(prepareChannelSendInput({ payload })).toEqual({ payload })
    for (
      const blocks of [[], Array(129).fill({ style: 'plain', text: 'hello' }), [{ style: 'html', text: '<b>x</b>' }], [{
        style: 'plain',
        text: 'x'.repeat(4097),
      }, { style: 'plain', text: 'x'.repeat(4096) }]]
    ) {
      expect(() => validateChannelSendPayload({ type: 'richtext', blocks })).toThrow('INVALID_CHANNEL_PAYLOAD')
    }
  })

  it('validates card content and explicit unsupported-type fallback without hidden downgrade', () => {
    const payload = { type: 'card', title: 'title', body: 'body' }
    expect(validateChannelSendPayload(payload)).toEqual(payload)
    for (const fallback of [{ mode: 'reject' }, { mode: 'text', text: 'explicit alternative' }]) {
      expect(validateChannelSendFallback(fallback)).toEqual(fallback)
      expect(prepareChannelSendInput({ payload, fallback })).toEqual({ payload, fallback })
      expect(prepareChannelSendInput({ content: payload, fallback })).toEqual({ content: payload, fallback })
    }
    for (
      const bad of [{ ...payload, title: 'x'.repeat(257) }, { ...payload, body: 'x'.repeat(16385) }, {
        type: 'card',
        handle: 'card:old',
      }]
    ) {
      expect(() => validateChannelSendPayload(bad)).toThrow('INVALID_CHANNEL_PAYLOAD')
    }
    for (
      const fallback of [
        'reject',
        'silent',
        { type: 'text', text: 'old alias' },
        { mode: 'text', text: '' },
        { mode: 'text', text: 'ok', onFailure: true },
        { mode: 'reject', text: 'extra' },
        { mode: 'text', type: 'text', text: 'mixed' },
        undefined,
      ]
    ) {
      expect(() => validateChannelSendFallback(fallback)).toThrow('INVALID_CHANNEL_PAYLOAD')
      expect(() => prepareChannelSendInput({ payload, fallback })).toThrow('INVALID_CHANNEL_PAYLOAD')
      expect(() => prepareChannelSendInput({ text: 'legacy', fallback })).toThrow('INVALID_CHANNEL_PAYLOAD')
    }
    expect(() => prepareChannelSendInput({ payload, content: payload })).toThrow('INVALID_CHANNEL_PAYLOAD')
    expect(
      validateChannelSendPayload({
        type: 'richtext',
        blocks: Array(128).fill({ text: 'x'.repeat(4096), style: 'strong' }),
      }),
    )
      .toMatchObject({ type: 'richtext' })
  })

  it.each([
    null,
    [],
    {},
    { type: 'unknown' },
    { type: 'text', text: '' },
    { type: 'text', text: ' ' },
    { type: 'text', text: 'x'.repeat(8193) },
    { type: 'text', text: 'hello', url: 'https://example.com' },
    { type: 'card', handle: 'card:ok', raw: { elements: [] } },
  ])('rejects invalid candidate %j', payload => {
    expect(() => validateChannelSendPayload(payload)).toThrow('INVALID_CHANNEL_PAYLOAD')
  })

  it('rejects mixed content and caller-claimed permissions', () => {
    for (const extra of [{ text: 'legacy' }, { media: {} }, { actor: 'admin' }, { permissions: ['send'] }]) {
      expect(() => prepareChannelSendInput({ ...extra, payload: { type: 'text', text: 'hello' } }))
        .toThrow('INVALID_CHANNEL_PAYLOAD')
    }
  })

  it('documents unavailable types, platform capability gates and no path authority', () => {
    const help = channelCliHelp('send')
    for (const type of ['image', 'audio', 'file', 'video', 'richtext', 'card']) {
      expect(help.toLowerCase()).toContain(type)
    }
    expect(help).toContain('Host')
    expect(help).toContain('No local paths')
    expect(help).toContain('per platform/type')
    expect(channelCliHelp('send-many')).toContain('no text fallback')
  })
})
