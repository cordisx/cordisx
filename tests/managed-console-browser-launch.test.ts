import { describe, expect, it } from 'vitest'
import {
  ManagedConsoleBrowserLaunch,
  supportsManagedConsoleBrowserLaunch,
  verifiedManagedConsoleBrowserApp,
} from '../packages/cli/src/launcher/managed-console-browser-launch.js'
import { MAX_STANDALONE_CONSOLE_ORIGINS } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'

const executable = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'
const builds = [
  ['25679', 'f056dea6c8c27d5221903826d59e2becfa209a4d'],
  ['25894', '699937d138fa785a0e6c724bbc5d01f243f4e4a4'],
] as const
const signature = (hash: string) =>
  [
    'Executable=' + executable,
    'Identifier=com.openai.codex',
    'TeamIdentifier=2DC432GLL2',
    'CDHash=' + hash,
  ].join('\n')

describe('managed browser console App admission', () => {
  it('does not publish standalone console origins after close starts during preparation', async () => {
    const launch = new ManagedConsoleBrowserLaunch()
    const lifetime = new AbortController()
    const preparation = launch.prepareStandalone(lifetime.signal).then(() => 'ready', () => 'cancelled')
    try {
      const closing = launch.close()
      await expect(launch.prepareStandalone(lifetime.signal)).rejects.toThrow('managed browser console unavailable')
      await Promise.all([closing, launch.close()])
      expect(await preparation).toBe('cancelled')
      expect(launch.boundary()).toBeUndefined()
      expect(await launch.prepareStandalone(lifetime.signal)).toHaveLength(MAX_STANDALONE_CONSOLE_ORIGINS)
    } finally {
      await launch.close()
    }
  })

  it('gives standalone documents distinct owned origins and releases them on close', async () => {
    const launch = new ManagedConsoleBrowserLaunch()
    const lifetime = new AbortController()
    const origins = await launch.prepareStandalone(lifetime.signal)
    try {
      expect(origins).toHaveLength(MAX_STANDALONE_CONSOLE_ORIGINS)
      expect(new Set(origins).size).toBe(origins.length)
      const input = {
        service: 'fixture',
        generation: 'one',
        upstream: 'http://127.0.0.1:12345',
        redeemPath: '/auth/browser',
        signal: lifetime.signal,
        verify: async () => true,
      } as const
      const first = launch.boundary()!.open(input)!
      const second = launch.boundary()!.open(input)!
      expect(first.origin).not.toBe(second.origin)
      expect(origins).toContain(first.origin)
      expect(origins).toContain(second.origin)
      expect(first.admit('a'.repeat(32))).toBe(true)
      expect(second.admit('b'.repeat(32))).toBe(true)
      first.dispose()
      expect(second.admit('c'.repeat(32))).toBe(false)
    } finally {
      await launch.close()
    }
    expect(launch.boundary()).toBeUndefined()
  })

  it.each(builds)('retains native browser support for signed App build %s', (build, hash) => {
    expect(verifiedManagedConsoleBrowserApp(executable, build + '\n', signature(hash))).toBe(true)
  })

  it('rejects unknown builds, mismatched signatures and another executable or publisher', () => {
    const signed = signature(builds[1][1])
    expect(verifiedManagedConsoleBrowserApp(executable, '25895', signed)).toBe(false)
    expect(verifiedManagedConsoleBrowserApp(executable, builds[0][0], signed)).toBe(false)
    expect(verifiedManagedConsoleBrowserApp('/tmp/another.app/Contents/MacOS/ChatGPT', builds[1][0], signed)).toBe(
      false,
    )
    expect(verifiedManagedConsoleBrowserApp(executable, builds[1][0], signed.replace('2DC432GLL2', 'OTHERTEAM')))
      .toBe(false)
  })

  it('keeps custom Host arguments and cancelled launches outside this browser boundary', async () => {
    await expect(supportsManagedConsoleBrowserLaunch(executable, ['--custom-argument'], new AbortController().signal))
      .resolves.toBe(false)
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(supportsManagedConsoleBrowserLaunch(executable, [], cancelled.signal)).resolves.toBe(false)
  })
})
