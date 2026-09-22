import vm from 'node:vm'
import { expect, it, vi } from 'vitest'
import { observeStartupTiming } from '../packages/cli/src/shortcuts/startup-timing.js'

it('logs bounded phase transitions per document, with only known enum and timing fields', () => {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const log = vi.fn()
  const timing = observeStartupTiming(
    {
      onEvent: (name, listener) => {
        listeners.set(name, listener)
        return () => {
          listeners.delete(name)
        }
      },
    },
    42,
    log,
  )
  const payloads: unknown[][] = []
  const context = vm.createContext({
    performance: { timeOrigin: 1000, now: () => 20 },
    console: {
      debug: (...args: unknown[]) => {
        payloads.push(args)
        listeners.get('Runtime.consoleAPICalled')!({ args: args.map(value => ({ value })) })
      },
    },
  })
  const trace = vm.runInContext(`(${timing.source})`, context)
  trace('editor-observed')
  trace('editor-observed')
  trace('account-read-complete', { status: 'unavailable', durationMs: 10, token: 'private-fixture' })
  trace('account-read-complete', { status: 'authenticated', durationMs: 5 })
  expect(log).toHaveBeenCalledTimes(3)
  expect(log).toHaveBeenLastCalledWith(expect.objectContaining({
    event: 'readiness-phase',
    documentTimeOrigin: 1000,
    observedAt: 1020,
    status: 'authenticated',
    durationMs: 5,
  }))
  expect(JSON.stringify(payloads)).not.toContain('private-fixture')
  trace('arbitrary-secret-phase')
  expect(log).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(payloads)).not.toContain('arbitrary-secret-phase')
  const emit = listeners.get('Page.frameNavigated')!
  emit({ frame: { parentId: 'child', url: 'app://-/index.html' } })
  emit({ frame: { url: 'app://-/index.html' } })
  emit({ frame: { url: 'app://-/index.html' } })
  expect(log).toHaveBeenCalledTimes(5)
  timing.close()
  expect(listeners.size).toBe(0)
})
