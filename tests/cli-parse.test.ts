import { describe, expect, it } from 'vitest'
import { CordisXCliParseError, parseCordisXCli } from '../packages/cli/src/cli/parse.js'

describe('parseCordisXCli', () => {
  it('parses the default launch without inventing an app or profile', () => {
    expect(parseCordisXCli([])).toEqual({
      action: 'launch',
      options: {
        attach: false,
        system: false,
        isolated: false,
        onlineDevtools: false,
        dryRun: false,
      },
      hostArgs: [],
    })
  })

  it('parses an app, profile, data mode, and the preserved launcher options', () => {
    expect(parseCordisXCli([
      'codex',
      'work',
      '--data',
      'host-isolated',
      '--profile-dir=/profiles/work',
      '--executable',
      '/Applications/ChatGPT.app',
      '--debug-port',
      '43123',
      '--online-devtools',
      '--dry-run',
    ])).toEqual({
      action: 'launch',
      app: 'codex',
      profile: 'work',
      dataMode: 'host-isolated',
      options: {
        attach: false,
        system: false,
        isolated: false,
        profileDir: '/profiles/work',
        executable: '/Applications/ChatGPT.app',
        debugPort: 43123,
        onlineDevtools: true,
        dryRun: true,
      },
      hostArgs: [],
    })
  })

  it('keeps every token after -- unchanged for the host', () => {
    expect(parseCordisXCli([
      'codex',
      '--',
      '--config',
      'host.json',
      '--',
      '-x',
    ])).toMatchObject({
      action: 'launch',
      app: 'codex',
      options: { attach: false },
      hostArgs: ['--config', 'host.json', '--', '-x'],
    })
  })

  it.each(['setup', 'config', 'doctor'] as const)('parses %s as a command action', action => {
    expect(parseCordisXCli([action])).toEqual({ action })
  })

  it('parses dev with one plugin path and preserved launcher options', () => {
    expect(parseCordisXCli([
      'dev',
      './plugins/demo.ts',
      '--system',
      '--',
      '--host-flag',
    ])).toEqual({
      action: 'dev',
      pluginPath: './plugins/demo.ts',
      options: {
        attach: false,
        system: true,
        isolated: false,
        onlineDevtools: false,
        dryRun: false,
      },
      hostArgs: ['--host-flag'],
    })
  })

  it('parses dev without an explicit path so project config discovery can run', () => {
    expect(parseCordisXCli(['dev'])).toEqual({
      action: 'dev',
      options: {
        attach: false,
        system: false,
        isolated: false,
        onlineDevtools: false,
        dryRun: false,
      },
      hostArgs: [],
    })
  })

  it('parses a development composition file without mixing it with a plugin path', () => {
    expect(parseCordisXCli(['dev', '--config', './cordisx.config.json'])).toMatchObject({
      action: 'dev',
      configPath: './cordisx.config.json',
    })
    expect(() => parseCordisXCli(['dev', './plugin.ts', '--config', './cordisx.config.json']))
      .toThrow('cordisx dev accepts either a plugin path or --config, not both')
    expect(() => parseCordisXCli(['dev', '--data', 'host-isolated']))
      .toThrow('--data is not valid with cordisx dev')
  })

  it.each(
    [
      [['--help'], { action: 'help' }],
      [['-h'], { action: 'help' }],
      [['help'], { action: 'help' }],
      [['codex', '--help'], { action: 'help' }],
    ] as const,
  )('returns help as an action for %j', (argv, expected) => {
    expect(parseCordisXCli(argv)).toEqual(expected)
  })

  it('rejects --config outside dev instead of loading a project config for ordinary launch', () => {
    expect(() => parseCordisXCli(['codex', '--config', './local.json'])).toThrowError(
      expect.objectContaining({
        code: 'unsupported-option',
        message: '--config is only valid with cordisx dev',
      }),
    )
    expect(() => parseCordisXCli(['setup', '-c', './local.json'])).toThrowError(
      '--config is only valid with cordisx dev',
    )
  })

  it('rejects a third launch positional and a second dev positional', () => {
    expect(() => parseCordisXCli(['codex', 'work', 'extra'])).toThrowError(
      'cordisx launch accepts at most two positional arguments: [app] [profile]',
    )
    expect(() => parseCordisXCli(['dev', './one', './two'])).toThrowError(
      'cordisx dev accepts at most one plugin path',
    )
  })

  it('rejects positionals and host arguments on non-launch commands', () => {
    expect(() => parseCordisXCli(['doctor', 'codex'])).toThrowError(
      'cordisx doctor does not accept positional arguments',
    )
    expect(() => parseCordisXCli(['setup', '--', '--host-flag'])).toThrowError(
      'cordisx setup does not accept host arguments after --',
    )
  })

  it('reports unknown and duplicate CordisX options explicitly', () => {
    expect(() => parseCordisXCli(['--wat'])).toThrowError(
      expect.objectContaining({ code: 'unknown-option', message: 'unknown CordisX option: --wat' }),
    )
    expect(() => parseCordisXCli(['--dry-run', '--dry-run'])).toThrowError(
      expect.objectContaining({ code: 'duplicate-option' }),
    )
  })

  it('reports missing and invalid values without consuming another option', () => {
    expect(() => parseCordisXCli(['--data', '--dry-run'])).toThrowError(
      expect.objectContaining({ code: 'missing-option-value', message: '--data requires a value' }),
    )
    expect(() => parseCordisXCli(['--data', 'private'])).toThrowError(
      '--data must be either "shared" or "host-isolated"',
    )
    expect(() => parseCordisXCli(['--debug-port', '80'])).toThrowError(
      '--debug-port must be an integer between 1024 and 65535',
    )
  })

  it('preserves the legacy launcher incompatibility errors', () => {
    expect(() => parseCordisXCli(['--system', '--isolated'])).toThrowError(
      '--system and --isolated cannot be used together',
    )
    expect(() => parseCordisXCli(['--attach', '--profile-dir', '/tmp/profile'])).toThrowError(
      '--attach cannot be combined with --isolated or --profile-dir',
    )
    expect(() => parseCordisXCli(['--attach', '--system'])).toThrowError(
      '--attach and --system cannot be used together',
    )
    expect(() => parseCordisXCli(['--system', '--profile-dir', '/tmp/profile'])).toThrowError(
      '--system and --profile-dir cannot be used together',
    )
    expect(() => parseCordisXCli(['codex', '--system', '--online-devtools'])).toThrowError(
      '--online-devtools is only valid with an independent Chromium profile',
    )
    expect(() => parseCordisXCli(['dev', '--system', '--online-devtools'])).toThrowError(
      '--online-devtools is only valid with an independent Chromium profile',
    )
    expect(() => parseCordisXCli(['codex', '--isolated'])).toThrowError(
      '--isolated is only valid with cordisx dev; use --data host-isolated for a separate Host root',
    )
    expect(parseCordisXCli(['dev', '--isolated', '--dry-run'])).toMatchObject({
      action: 'dev',
      options: { isolated: true },
    })
    expect(() => parseCordisXCli(['codex', 'work', '--attach'])).toThrowError(
      '--attach cannot select a named profile',
    )
    expect(() => parseCordisXCli(['codex', '--attach', '--data', 'shared'])).toThrowError(
      '--attach cannot override a host-data profile',
    )
    expect(() => parseCordisXCli(['codex', '--attach', '--executable', '/tmp/host'])).toThrowError(
      '--executable is not valid with --attach because no host is launched',
    )
    expect(() => parseCordisXCli(['codex', '--attach', '--online-devtools'])).toThrowError(
      '--online-devtools is not valid with --attach because the endpoint already exists',
    )
    expect(() => parseCordisXCli(['codex', '--attach', '--', '--host-flag'])).toThrowError(
      '--attach does not launch a host and cannot accept host arguments',
    )
  })

  it('enforces the portable named-profile grammar', () => {
    expect(() => parseCordisXCli(['codex', '../escape'])).toThrowError(
      'profile must match [a-z0-9][a-z0-9._-]{0,63}',
    )
    expect(() => parseCordisXCli(['codex', 'Work'])).toThrowError(CordisXCliParseError)
    expect(() => parseCordisXCli(['../codex'])).toThrow(
      'app must match [a-z0-9][a-z0-9._-]{0,63}',
    )
  })
})
