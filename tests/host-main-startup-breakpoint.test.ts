import { afterEach, expect, it, vi } from 'vitest'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { hasMatchingProcessIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { connectStartupCover, installStartupNavigation } from '../packages/cli/src/shortcuts/startup-cover.js'
import { installHostMainAgents, installOneShotStartupBreakpoint } from '../packages/cli/src/shortcuts/dock.js'

vi.mock('../packages/cli/src/cli/supervisor-state.js', () => ({
  hasMatchingProcessIdentity: vi.fn(),
}))
vi.mock('../packages/cli/src/shortcuts/startup-cover.js', () => ({
  connectStartupCover: vi.fn(),
  installStartupNavigation: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('removes the one-shot main startup breakpoint using its exact CDP identity', async () => {
  const send = vi.fn(async (method: string) =>
    method === 'Debugger.setBreakpointByUrl' ? { breakpointId: 'startup-breakpoint' } : {}
  )

  const remove = await installOneShotStartupBreakpoint({ send })
  await remove()

  expect(send.mock.calls).toEqual([
    ['Debugger.setBreakpointByUrl', { lineNumber: 0, urlRegex: 'early-bootstrap\\.js' }],
    ['Debugger.removeBreakpoint', { breakpointId: 'startup-breakpoint' }],
  ])
})

it('fails closed when CDP does not return the startup breakpoint identity', async () => {
  const send = vi.fn(async () => ({}))

  await expect(installOneShotStartupBreakpoint({ send })).rejects.toThrow(
    'Owned Host startup breakpoint was not installed',
  )
})

it('removes the startup breakpoint before resuming the real main-agent sequence', async () => {
  const calls: string[] = []
  let paused: ((params: Record<string, unknown>) => void) | undefined
  const session = {
    async send(method: string) {
      calls.push(method)
      if (method === 'Debugger.setBreakpointByUrl') return { breakpointId: 'startup-breakpoint' }
      if (method === 'Runtime.runIfWaitingForDebugger') {
        paused?.({ callFrames: [{ callFrameId: 'startup-frame' }] })
        return {}
      }
      if (method === 'Runtime.evaluate') return { result: { value: true } }
      return {}
    },
    onEvent(method: string, listener: (params: Record<string, unknown>) => void) {
      if (method === 'Debugger.paused') paused = listener
      return () => {
        paused = undefined
      }
    },
    close: vi.fn(),
  }
  vi.mocked(hasMatchingProcessIdentity).mockResolvedValue(true)
  vi.spyOn(CdpSession, 'connect').mockResolvedValue(session as unknown as CdpSession)
  vi.mocked(installStartupNavigation).mockImplementation(async () => {
    calls.push('installStartupNavigation')
  })
  vi.mocked(connectStartupCover).mockResolvedValue({
    startupNavigation: { target: {} as never, activate: vi.fn() },
    reveal: vi.fn(),
    close: vi.fn(),
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})

  await installHostMainAgents({
    inspectorUrl: 'ws://127.0.0.1:43123/00000000-0000-0000-0000-000000000000',
    hostPid: 42,
    hostStartedAt: 'identity',
    debugPort: 43124,
    readyStatePath: '/tmp/state.json',
    readyInstanceToken: 'generation',
  })

  expect(calls.indexOf('installStartupNavigation')).toBeLessThan(calls.indexOf('Debugger.removeBreakpoint'))
  expect(calls.indexOf('Debugger.removeBreakpoint')).toBeLessThan(calls.indexOf('Debugger.resume'))
  expect(calls.indexOf('Debugger.resume')).toBeLessThan(calls.indexOf('Runtime.evaluate'))
  expect(connectStartupCover).toHaveBeenCalledOnce()
})
