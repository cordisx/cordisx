import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalProviderAuthority,
  parseTerminalProviderRequest,
} from '../packages/cli/src/launcher/terminal-provider.js'
import { parseTerminalCli } from '../packages/cli/src/cli/terminal-parse.js'
import { terminalCodexArguments } from '../packages/cli/src/cli/terminal-command.js'
import type { NativeManagedGatewayConnectionSession } from '../packages/cli/src/launcher/managed-service-native-connection.js'

function fixture() {
  let generation = 'generation-one', clock = 1000
  const dispose = vi.fn()
  const releaseCredential = vi.fn()
  const resolve = vi.fn((): NativeManagedGatewayConnectionSession => ({
    value: {
      service: { pluginId: 'test-plugin', serviceId: 'gateway', generation },
      endpoint: {
        origin: 'http://127.0.0.1:54321',
        apiPath: '/v1',
        auth: { scheme: 'bearer', token: 'HOST_ONLY_TOKEN' },
      },
      models: {
        generation: 'model-one',
        defaultAlias: 'alias',
        aliases: [{ alias: 'alias', gatewayModelId: 'model-one' }],
      },
      cleanup: { authorityId: 'host-only' },
    },
    dispose,
  }))
  const prepare = vi.fn(async () => ({
    scheme: 'bearer' as const,
    serviceGeneration: generation,
    auth: {
      command: process.execPath,
      args: ['/private/helper.mjs', '/private/socket', 'opaque-handle'],
      cwd: '/private',
      timeout_ms: 5000,
      refresh_interval_ms: 200,
    },
    dispose: releaseCredential,
  }))
  const authority = createTerminalProviderAuthority({
    catalog: async () => [{
      providerId: 'plugin-provider',
      pluginId: 'test-plugin',
      models: [
        { id: 'model-one', label: 'One', aliases: ['alias'] },
      ],
    }],
    owns: id => id === 'plugin-provider',
    resolve,
    credentials: { prepare, close: async () => undefined },
    now: () => clock,
  })
  return {
    authority,
    prepare,
    releaseCredential,
    resolve,
    dispose,
    change: () => {
      generation = 'generation-two'
    },
    expire: () => {
      clock += 60_001
    },
  }
}

describe('terminal provider lifecycle', () => {
  it('lists without acquiring credentials and revokes only the selected launch on release', async () => {
    const f = fixture()
    try {
      expect(await f.authority.request({ kind: 'list' })).toMatchObject({
        kind: 'list',
        providers: [{ managed: true }],
      })
      expect(f.prepare).not.toHaveBeenCalled()
      const first = await f.authority.request({ kind: 'prepare', providerId: 'plugin-provider', model: 'model-one' })
      const second = await f.authority.request({ kind: 'prepare', providerId: 'plugin-provider', model: 'model-one' })
      if (first.kind !== 'prepared' || second.kind !== 'prepared') throw new Error('not prepared')
      expect(JSON.stringify(first)).not.toContain('HOST_ONLY_TOKEN')
      expect(first.provider).toMatchObject({ wire_api: 'responses', auth: { command: process.execPath } })
      await f.authority.request({ kind: 'release', leaseId: first.leaseId })
      await f.authority.request({ kind: 'release', leaseId: first.leaseId })
      expect(f.releaseCredential).toHaveBeenCalledTimes(1)
      expect(await f.authority.request({ kind: 'renew', leaseId: second.leaseId })).toEqual({ kind: 'renewed' })
    } finally {
      f.authority.close()
    }
    expect(f.releaseCredential).toHaveBeenCalledTimes(2)
  })

  it('rejects unknown models before credentials and revokes on generation replacement', async () => {
    const f = fixture()
    try {
      await expect(f.authority.request({ kind: 'prepare', providerId: 'plugin-provider', model: 'wrong' })).rejects
        .toThrow('Unknown')
      expect(f.prepare).not.toHaveBeenCalled()
      const result = await f.authority.request({ kind: 'prepare', providerId: 'plugin-provider', model: 'model-one' })
      if (result.kind !== 'prepared') throw new Error('not prepared')
      f.change()
      await expect(f.authority.request({ kind: 'renew', leaseId: result.leaseId })).rejects.toThrow('generation')
      expect(f.releaseCredential).toHaveBeenCalledOnce()
    } finally {
      f.authority.close()
    }
  })

  it('expires orphaned launches and refuses mutations after Host retirement', async () => {
    const f = fixture()
    const result = await f.authority.request({ kind: 'prepare', providerId: 'plugin-provider', model: 'model-one' })
    if (result.kind !== 'prepared') throw new Error('not prepared')
    f.expire()
    await expect(f.authority.request({ kind: 'renew', leaseId: result.leaseId })).rejects.toThrow('expired')
    expect(f.releaseCredential).toHaveBeenCalledOnce()
    f.authority.close()
    await expect(f.authority.request({ kind: 'list' })).rejects.toThrow('retired')
  })
})

describe('terminal argument boundaries', () => {
  it('preserves native provider commands and keeps CordisX profile distinct from Codex profile', () => {
    const invocation = parseTerminalCli(['cli', '--profile', 'work', '--', '--profile', 'review', 'resume', '--last'])
    expect(invocation.profile).toBe('work')
    expect(terminalCodexArguments(invocation)).toEqual(['--profile', 'review', 'resume', '--last'])
  })

  it.each([
    ['--model', 'other'],
    ['-mother'],
    ['--config', 'model_provider="other"'],
    ['-cmodel="other"'],
    ['--config=model_providers."other"={name="Other"}'],
    ['--remote', 'unix://'],
    ['--config', "'model' = 'other'"],
  ])('rejects selected-provider overrides %j', (...args) => {
    const invocation = parseTerminalCli(['cli', '--service', 'selected', '--model', 'chosen', '--', ...args])
    expect(() =>
      terminalCodexArguments(invocation, {
        kind: 'prepared',
        leaseId: 'lease',
        providerId: 'selected',
        model: 'chosen',
        provider: {},
      })
    ).toThrow('override')
  })

  it('serializes TOML values without invoking a shell and places configuration before exec input', () => {
    const invocation = parseTerminalCli([
      'cli',
      '--service',
      'selected',
      '--model',
      'chosen',
      '--',
      'exec',
      'literal `$(text)`',
    ])
    const args = terminalCodexArguments(invocation, {
      kind: 'prepared',
      leaseId: 'lease',
      providerId: 'selected',
      model: 'chosen',
      provider: {
        name: 'Provider',
        wire_api: 'responses',
        auth: { command: '/path with spaces/node', args: ['a\\b', '"quoted"'], timeout_ms: 5000 },
      },
    }, '/path/prompt.md')
    expect(args.slice(-2)).toEqual(['exec', 'literal `$(text)`'])
    expect(args).toContain('model_instructions_file="/path/prompt.md"')
    expect(args.join(' ')).not.toContain('HOST_ONLY_TOKEN')
  })

  it.each([
    ['cli', '--service', 'one'],
    ['cli', '--list', '--', 'exec'],
    ['cli', '--profile', '../other'],
    ['cli', '--model', 'one'],
    ['cli', '--service', 'a', '--service', 'b'],
  ])('rejects invalid selection %j', (...args) => expect(() => parseTerminalCli(args)).toThrow())

  it('validates the RPC operation fields rather than trusting an asserted TypeScript type', () => {
    expect(() => parseTerminalProviderRequest({ kind: 'list', token: 'spoof' })).toThrow()
    expect(() => parseTerminalProviderRequest({ kind: 'prepare', providerId: 'ok', model: 'bad\nmodel' })).toThrow()
  })
})
