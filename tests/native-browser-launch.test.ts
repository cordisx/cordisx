import type { ChildProcess } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ waitForPort: vi.fn() }))
vi.mock('./fixtures/chrome-debug-port.js', () => ({ waitForChromeDebugPort: mocked.waitForPort }))
vi.mock('./fixtures/chrome-launch-diagnostics.js', () => ({
  launchObservedChrome: vi.fn(),
  observeChromeReadiness: () => ({
    readActivePort: async (read: () => Promise<string>) => await read(),
    activePort: () => {},
    targetPoll: () => {},
    pageTargets: () => {},
    ready: () => {},
    failure: async (error: unknown) => error,
    dispose: async () => {},
  }),
}))

import { waitForChromeTarget } from './fixtures/native-browser-launch.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  mocked.waitForPort.mockReset()
})

it('still waits for the first page when Chrome publishes its port near the launch deadline', async () => {
  vi.useFakeTimers()
  const started = Date.now()
  mocked.waitForPort.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(43123), 29_300)))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () =>
        Date.now() >= started + 31_000
          ? [{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/page/example' }]
          : [],
    })),
  )
  const browser = { exitCode: null, signalCode: null } as ChildProcess
  const result = waitForChromeTarget('/isolated-profile', browser, () => '').then(
    value => ({ value }),
    error => ({ error: (error as Error).message }),
  )
  await vi.advanceTimersByTimeAsync(31_100)
  expect(await result).toEqual({ value: 'ws://127.0.0.1:43123/devtools/page/example' })
  expect(mocked.waitForPort.mock.calls[0]?.[3]).toBe(30_000)
})

it('still fails if no page appears within the bounded target wait', async () => {
  vi.useFakeTimers()
  mocked.waitForPort.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(43123), 29_300)))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })))
  const browser = { exitCode: null, signalCode: null } as ChildProcess
  const result = waitForChromeTarget('/isolated-profile', browser, () => '').then(
    value => ({ value }),
    error => ({ error: (error as Error).message }),
  )
  await vi.advanceTimersByTimeAsync(40_000)
  expect(await result).toEqual({ error: expect.stringContaining('timed out waiting for Chrome CDP') })
})
