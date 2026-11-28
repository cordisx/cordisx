import { connect } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  ManagedConsoleBrowserLaunch,
  supportsManagedConsoleBrowserLaunch,
  verifiedManagedConsoleBrowserApp,
} from '../packages/cli/src/launcher/managed-console-browser-launch.js'
import { MAX_STANDALONE_CONSOLE_ORIGINS } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'
import * as browserGateway from '../packages/cli/src/launcher/managed-console-browser-gateway.js'

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

async function canConnect(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

describe('managed browser console App admission', () => {
  it('keeps the launch unavailable when in-flight listener cleanup is unconfirmed', async () => {
    const gateway = await browserGateway.openManagedConsoleBrowserGateway()
    const open = vi.spyOn(browserGateway, 'openManagedConsoleBrowserGateway').mockResolvedValueOnce({
      ...gateway,
      async close() {
        await gateway.close()
        throw new Error('fixture cleanup failure')
      },
    })
    const launch = new ManagedConsoleBrowserLaunch()
    const signal = new AbortController().signal
    const preparation = launch.prepareStandalone(signal).then(() => 'ready', () => 'cancelled')
    try {
      await expect(launch.close()).rejects.toThrow('managed browser console cleanup unavailable')
      expect(await preparation).toBe('cancelled')
      expect(launch.boundary()).toBeUndefined()
      await expect(launch.prepareStandalone(signal)).rejects.toThrow('managed browser console unavailable')
    } finally {
      await launch.close().catch(() => undefined)
      await gateway.close()
      open.mockRestore()
    }
  })

  it('waits for an in-flight listener to close before acknowledging shutdown', async () => {
    const gateway = await browserGateway.openManagedConsoleBrowserGateway()
    const port = Number(new URL(gateway.origin).port)
    let release!: () => void
    const waiting = new Promise<void>(resolve => release = resolve)
    const open = vi.spyOn(browserGateway, 'openManagedConsoleBrowserGateway').mockImplementationOnce(async () => {
      await waiting
      return gateway
    })
    const launch = new ManagedConsoleBrowserLaunch()
    const preparation = launch.prepareStandalone(new AbortController().signal).then(() => 'ready', () => 'cancelled')
    let closed = false
    const closing = launch.close().then(() => closed = true)
    try {
      expect(await canConnect(port)).toBe(true)
      expect(closed).toBe(false)
      release()
      await closing
      expect(await preparation).toBe('cancelled')
      expect(await canConnect(port)).toBe(false)
    } finally {
      release()
      await launch.close()
      await gateway.close()
      open.mockRestore()
    }
  })

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
