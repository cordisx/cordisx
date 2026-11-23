import { afterEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn(async () => ({ status: 'ok', receipt: { state: 'sent' } })))
vi.mock('../packages/cli/src/config/home-config.js', () => ({
  resolveHomeConfigPath: () => '/tmp/channel-send-fixture/config.json',
  loadHomeConfig: async () => ({
    defaultApp: 'codex',
    apps: { codex: { defaultProfile: 'default', profiles: { default: {} } } },
  }),
}))
vi.mock('../packages/cli/src/launcher/management-rpc.js', () => ({
  pluginManagementRpcPaths: () => ({ fixture: true }),
  readPluginManagementRpcEndpoint: async () => ({
    appId: 'codex',
    profileId: 'default',
    configPath: '/tmp/channel-send-fixture/config.json',
  }),
  usesNamespacedManagementRpc: async () => true,
  requestNamespacedManagementRpc: rpc,
  requestPluginManagementRpc: rpc,
}))
import { runConfiguredChannelCommand } from '../packages/cli/src/cli/channel-configured-command.js'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('configured send RPC boundary', () => {
  it('rejects obsolete fallback aliases before RPC', async () => {
    for (const fallback of ['reject', { type: 'text', text: 'old' }, { mode: 'reject', text: 'extra' }]) {
      await expect(runConfiguredChannelCommand([
        'send',
        '--input',
        JSON.stringify({
          content: { type: 'file', handle: 'media:issued' },
          fallback,
        }),
      ], () => {})).rejects.toThrow('INVALID_CHANNEL_PAYLOAD')
    }
    expect(rpc).not.toHaveBeenCalled()
  })
  it('dispatches format/filename/durationMs without requiring mediaType', async () => {
    const input = {
      account: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant' },
      target: { id: 'oc_chat', kind: 'group' },
      operationId: 'video-once',
      type: 'video',
      format: 'mp4',
      filename: 'clip.mp4',
      durationMs: 1234,
      size: 1,
      sha256: 'a'.repeat(64),
    }
    await runConfiguredChannelCommand(['media-prepare', 'begin', '--input', JSON.stringify(input)], () => {})
    expect(rpc).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        operation: 'media-prepare',
        input: { ...input, action: 'begin' },
      }),
    )
  })
  it('dispatches all media-prepare subactions through the configured Host with context and thread', async () => {
    vi.stubEnv('CODEX_THREAD_ID', 'own-thread')
    const inputs = [
      {
        account: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant' },
        target: { id: 'oc_chat', kind: 'group' },
        operationId: 'stable',
        type: 'file',
        format: 'binary',
        filename: 'a.bin',
        mediaType: 'application/octet-stream',
        size: 1,
        sha256: 'a'.repeat(64),
      },
      { uploadId: 'upload:host-issued', offset: 0, bytesBase64: 'YQ==' },
      { uploadId: 'upload:host-issued' },
    ]
    const actions = ['begin', 'chunk', 'commit']
    for (const [index, input] of inputs.entries()) {
      const stdout = vi.fn()
      await runConfiguredChannelCommand([
        'media-prepare',
        actions[index]!,
        '--profile',
        'default',
        '--context',
        'host-context',
        '--input',
        JSON.stringify(input),
      ], stdout)
      expect(rpc).toHaveBeenLastCalledWith({ fixture: true }, expect.anything(), {
        kind: 'channel',
        operation: 'media-prepare',
        input: { ...input, action: actions[index] },
        context: 'host-context',
        callerThreadId: 'own-thread',
      })
      expect(stdout).toHaveBeenCalledOnce()
    }
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('rejects invalid media-prepare argv and oversized chunks before dispatch', async () => {
    for (
      const args of [
        [
          'media-prepare',
          'chunk',
          '--input',
          JSON.stringify({ uploadId: 'upload:ok', offset: 0, bytesBase64: Buffer.alloc(65537).toString('base64') }),
        ],
        ['media-prepare', 'begin', '--path', '/tmp/private'],
        ['media-prepare', 'commit', '--input', '{"uploadId":"upload:ok","action":"begin"}'],
        ['media-prepare', '--input', '{"action":"commit","uploadId":"upload:ok","actor":"admin"}'],
      ]
    ) await expect(runConfiguredChannelCommand(args, () => {})).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('supports action-in-input and prints the exact Host preparation response', async () => {
    const result = {
      status: 'ok',
      media: {
        type: 'file',
        handle: 'media:host-issued',
        size: 1,
        sha256: 'a'.repeat(64),
        format: 'binary',
        filename: 'a.bin',
      },
    }
    rpc.mockResolvedValueOnce(result as never)
    const stdout = vi.fn()
    await runConfiguredChannelCommand([
      'media-prepare',
      '--input',
      '{"action":"commit","uploadId":"upload:host-issued"}',
    ], stdout)
    expect(rpc).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        operation: 'media-prepare',
        input: { action: 'commit', uploadId: 'upload:host-issued' },
      }),
    )
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(result))
  })
  it('rejects oversized typed content before RPC without truncation', async () => {
    const content = { type: 'richtext', blocks: Array(128).fill({ text: 'x'.repeat(4096), style: 'plain' }) }
    await expect(runConfiguredChannelCommand(['send', '--input', JSON.stringify({ content })], () => {}))
      .rejects.toThrow('CHANNEL_RPC_INPUT_TOO_LARGE')
    expect(rpc).not.toHaveBeenCalled()
  })
  it('preserves explicit fallback and Host unsupported result without retry', async () => {
    const result = { status: 'rejected', code: 'CHANNEL_MESSAGE_TYPE_UNSUPPORTED' }
    rpc.mockResolvedValueOnce(result as never)
    const input = {
      content: { type: 'file', handle: 'media:host-issued' },
      fallback: { mode: 'text', text: 'alternative' },
    }
    const stdout = vi.fn()
    await expect(runConfiguredChannelCommand(['send', '--input', JSON.stringify(input)], stdout))
      .rejects.toThrow('CHANNEL_OPERATION_REJECTED')
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ input }))
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(result))
  })
  it.each(['send', 'send-many'])('normalizes typed text for %s while forwarding Host context', async operation => {
    vi.stubEnv('CODEX_THREAD_ID', 'own-thread')
    const input = {
      account: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant' },
      ...(operation === 'send'
        ? { target: { id: 'oc_chat', kind: 'group' } }
        : { targets: [{ id: 'oc_chat', kind: 'group' }] }),
      operationId: 'stable-once',
      payload: { type: 'text', text: 'hello' },
    }
    const stdout = vi.fn()
    await runConfiguredChannelCommand(
      [operation, '--context', 'host-context', '--input', JSON.stringify(input)],
      stdout,
    )
    const { payload, ...scope } = input
    expect(rpc).toHaveBeenCalledWith({ fixture: true }, expect.anything(), {
      kind: 'channel',
      operation,
      input: { ...scope, text: payload.text },
      context: 'host-context',
      callerThreadId: 'own-thread',
    })
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ status: 'ok', receipt: { state: 'sent' } }))
  })

  it.each(['send', 'send-many'])(
    'forwards non-text %s for Host capability judgment without fallback',
    async operation => {
      const stdout = vi.fn()
      for (
        const payload of [{ type: 'image', handle: 'media:host-issued' }, {
          type: 'card',
          title: 'title',
          body: 'body',
        }]
      ) {
        await runConfiguredChannelCommand([operation, '--input', JSON.stringify({ payload })], stdout)
        expect(rpc).toHaveBeenLastCalledWith(
          { fixture: true },
          expect.anything(),
          expect.objectContaining({ input: { payload } }),
        )
      }
      expect(rpc).toHaveBeenCalledTimes(2)
      expect(stdout).toHaveBeenCalledTimes(2)
    },
  )
})
