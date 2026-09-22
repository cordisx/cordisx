import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchAndInject } from '../packages/cli/src/launcher/cdp.js'
import { install } from '../packages/cli/src/launcher/cdp-installation.js'
import { uninstall } from '../packages/cli/src/launcher/cdp-installation-support.js'

vi.mock('../packages/cli/src/launcher/cdp-installation.js', () => ({ install: vi.fn() }))
vi.mock('../packages/cli/src/launcher/cdp-installation-support.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/cli/src/launcher/cdp-installation-support.js')>(),
  uninstall: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(install).mockReset()
  vi.mocked(uninstall).mockReset()
})

describe('watcher exit causality', () => {
  it.each(['primary-and-cleanup', 'cleanup-only', 'normal'] as const)(
    '%s retains the correct failure boundary',
    async mode => {
      const controller = new AbortController()
      const target = {
        id: 'target',
        title: 'Codex',
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: 'ws://fixture',
      }
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([target]))))
      let closed = false
      vi.mocked(install).mockResolvedValue({ target, session: { isClosed: () => closed } } as never)
      const primary = new Error('private readiness error body')
      const cleanup = new Error('strict permission restoration failed')
      vi.mocked(uninstall).mockImplementation(async () => {
        closed = true
        if (mode !== 'normal') throw cleanup
      })
      const statuses: string[] = []
      const watching = watchAndInject({
        port: 1234,
        source: '',
        signal: controller.signal,
        onStatus: line => statuses.push(line),
        onReady: () => {
          controller.abort()
          if (mode === 'primary-and-cleanup') throw primary
        },
      })
      if (mode === 'normal') await expect(watching).resolves.toBeUndefined()
      else {
        const failure = await watching.catch(error => error) as AggregateError
        expect(failure).toBeInstanceOf(AggregateError)
        expect(failure.errors).toEqual(mode === 'primary-and-cleanup' ? [primary, cleanup] : [cleanup])
        expect(failure.cause).toBe(mode === 'primary-and-cleanup' ? primary : undefined)
        expect(failure.message.includes('watcher failed before cleanup')).toBe(mode === 'primary-and-cleanup')
      }
      const diagnostics = statuses.filter(line => line.startsWith('lifecycle ')).map(line => JSON.parse(line.slice(10)))
      expect(diagnostics.map(item => item.event)).toEqual(
        mode === 'primary-and-cleanup'
          ? ['watcher-failed', 'watcher-cleanup-started']
          : ['watcher-cleanup-started'],
      )
      for (const entry of diagnostics) {
        expect(entry).toMatchObject({
          at: expect.any(Number),
          launcherPid: process.pid,
          aborted: true,
          installedTargets: 1,
          closedSessions: 0,
        })
        expect(Object.keys(entry).sort()).toEqual([
          'aborted',
          'at',
          'closedSessions',
          'event',
          'installedTargets',
          'launcherPid',
          'stage',
        ])
      }
      expect(JSON.stringify(diagnostics)).not.toContain('private')
      expect(uninstall).toHaveBeenCalledOnce()
    },
  )
})
