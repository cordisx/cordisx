import { describe, expect, it } from 'vitest'
import { type CordisXManagedInvocation, parseCordisXCli } from '../cli/parse.js'
import { launchFingerprint } from '../cli/launch-fingerprint.js'
import { shortcutArgv, shortcutKey } from './model.js'
const parse = (args: string[]) => parseCordisXCli(args) as CordisXManagedInvocation
const fingerprint = (args: string[]) => {
  const v = parse(args)
  return launchFingerprint({
    source: 'unchanged profile',
    options: v.options,
    hostArgs: v.hostArgs,
    dataMode: v.dataMode ?? 'shared',
    cwd: '/work',
  })
}
describe('shortcut launch intent', () => {
  it('only adds a one-shot start operation, never a Host option', () => {
    const v = parse(['codex', 'work', '--create-shortcut'])
    expect(v.createShortcut).toBe(true)
    expect(v.options).not.toHaveProperty('createShortcut')
    expect(parse(['codex', 'work', '--', '--create-shortcut']).createShortcut).toBeUndefined()
    for (const args of [['run'], ['dev'], ['status'], ['--attach'], ['--system'], ['--dry-run']]) {
      expect(() => parse([...args, '--create-shortcut'])).toThrow()
    }
  })
  it('creation and GUI output cannot change instance identity; effective data mode can', () => {
    expect(fingerprint(['codex', 'work', '--create-shortcut', '--json'])).toBe(fingerprint(['codex', 'work']))
    expect(fingerprint(['codex', 'work', '--data', 'shared'])).not.toBe(
      fingerprint(['codex', 'work', '--data', 'host-isolated']),
    )
  })
  it('does not treat first-boot management bookkeeping as a launch change', () => {
    const base = { apps: { codex: { profiles: { work: { management: { revision: 0, sources: [] } } } } } }
    const migrated = structuredClone(base) as {
      apps: {
        codex: {
          profiles: {
            work: { management: { revision: number; sources: { url: string }[]; migrations?: Record<string, boolean> } }
          }
        }
      }
    }
    migrated.apps.codex.profiles.work.management.revision = 1
    migrated.apps.codex.profiles.work.management.migrations = { legacyBrowserSourcesV2: true }
    const v = parse(['codex', 'work'])
    const hash = (source: unknown) =>
      launchFingerprint({
        source: JSON.stringify(source),
        options: v.options,
        hostArgs: [],
        dataMode: 'shared',
        cwd: '/work',
      })
    expect(hash(base)).toBe(hash(migrated))
    migrated.apps.codex.profiles.work.management.sources.push({ url: 'https://example.com' })
    expect(hash(base)).not.toBe(hash(migrated))
  })
  it('pins the effective data mode and exact path tokens without shell execution', () => {
    expect(shortcutArgv(parse(['codex', 'work']), 'codex', 'work', '/safe', 'shared'))
      .toEqual(['start', 'codex', 'work', '--data', 'shared'])
    expect(
      shortcutArgv(
        parse(['codex', 'work', '--executable', './a b;$(touch nope)']),
        'codex',
        'work',
        '/safe',
        'host-isolated',
      ),
    )
      .toEqual(['start', 'codex', 'work', '--data', 'host-isolated', '--executable', '/safe/a b;$(touch nope)'])
    expect(() => shortcutArgv(parse(['codex', 'work', '--', 'secret']), 'codex', 'work', '/safe', 'shared')).toThrow(
      'does not persist',
    )
    const unsupported = parse(['codex', 'work'])
    expect(() =>
      shortcutArgv(
        { ...unsupported, options: { ...unsupported.options, debugPort: 9222 } },
        'codex',
        'work',
        '/safe',
        'shared',
      )
    ).toThrow('does not persist')
    expect(() =>
      shortcutArgv(
        { ...unsupported, options: { ...unsupported.options, onlineDevtools: true } },
        'codex',
        'work',
        '/safe',
        'shared',
      )
    ).toThrow('does not persist')
    expect(shortcutKey('/home', 'codex', 'work', 'shared')).not.toBe(
      shortcutKey('/home', 'codex', 'personal', 'shared'),
    )
    expect(shortcutKey('/home', 'codex', 'work', 'shared')).not.toBe(
      shortcutKey('/home', 'codex', 'work', 'host-isolated'),
    )
  })
})
