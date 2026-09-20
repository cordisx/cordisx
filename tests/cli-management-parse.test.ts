import { describe, expect, it } from 'vitest'
import { CordisXCliParseError, parseCordisXCli } from '../packages/cli/src/cli/parse.js'

describe('management CLI parsing', () => {
  it('parses plugin queries with profile and JSON selection', () => {
    expect(parseCordisXCli(['plugin', 'list', '--include-hidden', '--profile', 'work', '--json'])).toEqual({
      action: 'management',
      namespace: 'plugin',
      command: 'list',
      includeHidden: true,
      options: { profile: 'work', json: true, dryRun: false, yes: false },
    })
    expect(parseCordisXCli(['plugin', 'search', 'calendar'])).toMatchObject({
      namespace: 'plugin',
      command: 'search',
      query: 'calendar',
    })
    expect(parseCordisXCli([
      'plugin',
      'search',
      'calendar',
      '--source',
      'https://plugins.example/catalog.json',
      '--version',
      '2.0.0',
    ])).toMatchObject({
      source: 'https://plugins.example/catalog.json',
      version: '2.0.0',
    })
    expect(parseCordisXCli([
      'plugin',
      'info',
      'com.example.calendar',
      '--source',
      'https://plugins.example/catalog.json',
      '--version',
      '2.0.0',
    ])).toMatchObject({
      namespace: 'plugin',
      command: 'info',
      target: 'com.example.calendar',
      source: 'https://plugins.example/catalog.json',
      version: '2.0.0',
    })
  })

  it.each(['install', 'update'] as const)('parses plugin %s selectors and mutation controls', command => {
    expect(parseCordisXCli([
      'plugin',
      command,
      'com.example.calendar',
      '--source',
      'team',
      '--version=2.0.0',
      '--dry-run',
      '--yes',
    ])).toMatchObject({
      namespace: 'plugin',
      command,
      target: 'com.example.calendar',
      source: 'team',
      version: '2.0.0',
      options: { json: false, dryRun: true, yes: true },
    })
  })

  it.each(['enable', 'disable', 'uninstall', 'hide', 'unhide'] as const)(
    'parses plugin %s as a target mutation',
    command => {
      expect(parseCordisXCli(['plugin', command, 'com.example.calendar'])).toMatchObject({
        namespace: 'plugin',
        command,
        target: 'com.example.calendar',
      })
    },
  )

  it('accepts a source URL or configured name to disambiguate catalog hide and unhide', () => {
    expect(parseCordisXCli([
      'plugin',
      'hide',
      'com.example.calendar',
      '--source',
      'https://plugins.example/catalog.json',
    ])).toMatchObject({
      command: 'hide',
      target: 'com.example.calendar',
      source: 'https://plugins.example/catalog.json',
    })
    expect(parseCordisXCli(['plugin', 'unhide', 'com.example.calendar', '--source', 'team'])).toMatchObject({
      command: 'unhide',
      source: 'team',
    })
  })

  it('parses source CRUD, trust, and refresh operations', () => {
    expect(parseCordisXCli([
      'source',
      'add',
      'https://plugins.example/catalog.json',
      '--name',
      'Example',
      '--description=Team catalog',
      '--trusted',
    ])).toMatchObject({
      namespace: 'source',
      command: 'add',
      url: 'https://plugins.example/catalog.json',
      name: 'Example',
      description: 'Team catalog',
      trusted: true,
    })
    expect(parseCordisXCli([
      'source',
      'edit',
      'https://plugins.example/catalog.json',
      '--url',
      'http://127.0.0.1:43124/catalog.json',
      '--name',
      '',
      '--untrusted',
    ])).toMatchObject({
      command: 'edit',
      target: 'https://plugins.example/catalog.json',
      url: 'http://127.0.0.1:43124/catalog.json',
      name: '',
      trusted: false,
    })
    expect(parseCordisXCli(['source', 'refresh'])).toMatchObject({ command: 'refresh' })
    expect(parseCordisXCli(['source', 'refresh', 'https://plugins.example/catalog.json'])).toMatchObject({
      command: 'refresh',
      target: 'https://plugins.example/catalog.json',
    })
  })

  it.each(['enable', 'disable', 'remove'] as const)('parses source %s mutations', command => {
    expect(
      parseCordisXCli([
        'source',
        command,
        'https://plugins.example/catalog.json',
        '--profile=work',
        '--yes',
      ]),
    ).toMatchObject({
      namespace: 'source',
      command,
      target: 'https://plugins.example/catalog.json',
      options: { profile: 'work', yes: true },
    })
  })

  it('routes namespace help without treating management options as launcher options', () => {
    expect(parseCordisXCli(['plugin', '--help'])).toMatchObject({
      action: 'management',
      namespace: 'plugin',
      command: 'help',
    })
    expect(parseCordisXCli(['source', 'help'])).toMatchObject({
      action: 'management',
      namespace: 'source',
      command: 'help',
    })
  })

  it('rejects missing operands, contradictory trust, and meaningless options', () => {
    expect(() => parseCordisXCli(['plugin', 'info'])).toThrow('Usage: cordisx plugin info')
    expect(() => parseCordisXCli(['plugin', 'list', '--yes'])).toThrow('--yes is not valid')
    expect(() => parseCordisXCli(['plugin', 'enable', 'example', '--version', '2'])).toThrow(
      '--version is not valid',
    )
    expect(() => parseCordisXCli(['source', 'edit', 'https://plugins.example/catalog.json'])).toThrow(
      'requires --url, --name, --description, --trusted, or --untrusted',
    )
    expect(() => parseCordisXCli(['source', 'add', 'https://example.test', '--url', 'https://other.test']))
      .toThrow('--url is not valid')
    expect(() =>
      parseCordisXCli([
        'source',
        'add',
        'https://example.test',
        '--trusted',
        '--untrusted',
      ])
    ).toThrow('--trusted and --untrusted cannot be used together')
    expect(() => parseCordisXCli(['source', 'refresh', '--yes'])).toThrow('--yes is not valid')
  })

  it('preserves strict option and profile validation', () => {
    expect(() => parseCordisXCli(['plugin', 'list', '--profile', '../escape'])).toThrow(
      'profile must match [a-z0-9][a-z0-9._-]{0,63}',
    )
    expect(() => parseCordisXCli(['source', 'list', '--json', '--json'])).toThrow(CordisXCliParseError)
    expect(() => parseCordisXCli(['plugin', 'list', '--unknown'])).toThrow('unknown CordisX management option')
    expect(() => parseCordisXCli(['source', 'refresh', '--', '--host-flag'])).toThrow(
      'do not accept host arguments after --',
    )
  })
})
