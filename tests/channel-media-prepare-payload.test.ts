import { describe, expect, it } from 'vitest'
import { channelCliHelp } from '../packages/cli/src/cli/channel-command-help.js'
import {
  parseChannelMediaPrepareArgv,
  validateChannelMediaPrepareRequest,
} from '../packages/cli/src/cli/channel-media-prepare-payload.js'

describe('media prepare candidate argv and schema', () => {
  it('advertises the candidate three-step configured command without installed claims', () => {
    expect(channelCliHelp()).toContain('media-prepare')
    expect(channelCliHelp('media-prepare')).toContain('begin|chunk|commit')
    expect(channelCliHelp('media-prepare')).toContain('installed support is not implied')
  })
  const begin = {
    account: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant' },
    target: { id: 'oc_chat', kind: 'group' },
    operationId: 'stable',
    type: 'file',
    format: 'binary',
    filename: 'a.bin',
    mediaType: 'application/octet-stream',
    size: 65537,
    sha256: 'a'.repeat(64),
  }
  it('parses begin, chunk and commit without dispatching or reading paths', () => {
    expect(
      parseChannelMediaPrepareArgv([
        'begin',
        '--input',
        JSON.stringify(begin),
        '--context',
        'host-context',
        '--profile',
        'default',
      ]),
    )
      .toEqual({ input: { ...begin, action: 'begin' }, context: 'host-context', profile: 'default' })
    const chunk = { uploadId: 'upload:host-issued', offset: 0, bytesBase64: Buffer.alloc(65536).toString('base64') }
    const parsed = parseChannelMediaPrepareArgv(['chunk', '--input', JSON.stringify(chunk)])
    expect(parsed.input).toEqual({ ...chunk, action: 'chunk' })
    expect(Buffer.byteLength(JSON.stringify({ kind: 'channel', operation: 'media-prepare', input: parsed.input })))
      .toBeLessThan(262144)
    expect(parseChannelMediaPrepareArgv(['commit', '--input', '{"uploadId":"upload:host-issued"}']).input)
      .toEqual({ action: 'commit', uploadId: 'upload:host-issued' })
  })
  it('rejects oversized, noncanonical chunks and caller-claimed authority', () => {
    for (
      const extra of [
        { bytesBase64: Buffer.alloc(65537).toString('base64') },
        { bytesBase64: 'YR==' },
        { offset: -1 },
        { offset: 0.5 },
        { path: '/tmp/private' },
        { actor: 'admin' },
        { uploadId: '/tmp/upload' },
      ]
    ) {
      expect(() =>
        validateChannelMediaPrepareRequest({
          action: 'chunk',
          uploadId: 'upload:ok',
          offset: 0,
          bytesBase64: 'YQ==',
          ...extra,
        })
      )
        .toThrow('INVALID_CHANNEL_PAYLOAD')
    }
    for (
      const extra of [{ size: 0 }, { size: 1.5 }, { sha256: 'bad' }, { path: '/tmp/private' }, { bytesBase64: 'YQ==' }]
    ) {
      expect(() => validateChannelMediaPrepareRequest({ ...begin, action: 'begin', ...extra })).toThrow(
        'INVALID_CHANNEL_PAYLOAD',
      )
    }
    expect(() => validateChannelMediaPrepareRequest({ action: 'commit', uploadId: 'upload:ok', target: {} })).toThrow(
      'INVALID_CHANNEL_PAYLOAD',
    )
  })
  it('bounds single RPC input and rejects duplicate flags/action injection', () => {
    expect(() => parseChannelMediaPrepareArgv(['chunk', '--input', ' '.repeat(262144)])).toThrow(
      'CHANNEL_RPC_INPUT_TOO_LARGE',
    )
    for (
      const args of [
        ['begin', '--path', '/tmp/private'],
        ['commit', '--input', '{}', '--input', '{}'],
        ['commit', '--input', '{"action":"begin"}'],
        ['commit', '--input', '{'],
        ['unknown'],
      ]
    ) {
      expect(() => parseChannelMediaPrepareArgv(args)).toThrow()
    }
  })
  it('accepts Host metadata formats without mediaType and validates optional aliases', () => {
    for (
      const metadata of [
        { type: 'image', format: 'png', filename: 'image.png' },
        { type: 'audio', format: 'opus', durationMs: 1234 },
        { type: 'file', format: 'pdf', filename: 'document.pdf' },
        { type: 'video', format: 'mp4', filename: 'clip.mp4', durationMs: 1234 },
      ]
    ) {
      const { mediaType, ...withoutMime } = begin
      const input = { ...withoutMime, ...metadata, action: 'begin' }
      expect(validateChannelMediaPrepareRequest(input)).toEqual(input)
    }
    for (
      const extra of [{ mediaType: 'image/png' }, { filename: '../private' }, { durationMs: 1 }, { format: 'pdf' }, {
        name: 'different.bin',
      }]
    ) {
      expect(() => validateChannelMediaPrepareRequest({ ...begin, action: 'begin', ...extra })).toThrow(
        'INVALID_CHANNEL_PAYLOAD',
      )
    }
  })
})
