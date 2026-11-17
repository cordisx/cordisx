import { describe, expect, it } from 'vitest'
import {
  supportsManagedConsoleBrowserLaunch,
  verifiedManagedConsoleBrowserApp,
} from '../packages/cli/src/launcher/managed-console-browser-launch.js'

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
