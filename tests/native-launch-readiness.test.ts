import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type NativeLaunchReadinessDependency,
  NativeLaunchReadinessError,
  prepareNativeLaunchReadiness,
} from '../packages/cli/src/launcher/native-launch-readiness.js'

afterEach(() => vi.useRealTimers())

function dependency(
  id: string,
  events: string[],
  options: {
    readonly failPrepare?: boolean
    readonly failDispose?: boolean
    readonly onPrepare?: () => void
    readonly prepare?: () => Promise<string>
    readonly dispose?: (value: string) => Promise<void>
  } = {},
): NativeLaunchReadinessDependency<string> {
  return {
    id,
    prepareTimeoutMs: 100,
    disposeTimeoutMs: 100,
    prepare: async () => {
      events.push(`prepare:${id}`)
      options.onPrepare?.()
      if (options.prepare !== undefined) return await options.prepare()
      if (options.failPrepare === true) throw new Error('private credential value')
      return `opaque:${id}`
    },
    dispose: async value => {
      events.push(`dispose:${value}`)
      if (options.dispose !== undefined) return await options.dispose(value)
      if (options.failDispose === true) throw new Error('private process path')
    },
  }
}

describe('native launch readiness', () => {
  it('prepares dependencies in order and disposes them once in reverse order', async () => {
    const events: string[] = []
    const session = await prepareNativeLaunchReadiness([
      dependency('backend', events),
      dependency('gateway', events),
    ], new AbortController().signal)

    expect(session.dependencies).toEqual([
      { id: 'backend', value: 'opaque:backend' },
      { id: 'gateway', value: 'opaque:gateway' },
    ])
    await session.dispose()
    await session.dispose()
    expect(events).toEqual([
      'prepare:backend',
      'prepare:gateway',
      'dispose:opaque:gateway',
      'dispose:opaque:backend',
    ])
  })

  it('stops before later preparation and reports a bounded failure', async () => {
    const events: string[] = []
    const later = dependency('native-provider', events)
    const laterPrepare = vi.spyOn(later, 'prepare')

    await expect(prepareNativeLaunchReadiness([
      dependency('backend', events),
      dependency('gateway', events, { failPrepare: true }),
      later,
    ], new AbortController().signal)).rejects.toMatchObject({
      code: 'prepare-failed',
      dependencyId: 'gateway',
      cleanupFailed: false,
    })
    expect(laterPrepare).not.toHaveBeenCalled()
    expect(events).toEqual([
      'prepare:backend',
      'prepare:gateway',
      'dispose:opaque:backend',
    ])
    await expect(prepareNativeLaunchReadiness([
      dependency('secret-bearing', [], { failPrepare: true }),
    ], new AbortController().signal)).rejects.not.toThrow('private credential value')
  })

  it('cancels after a prepared dependency and cleans it before returning', async () => {
    const events: string[] = []
    const controller = new AbortController()

    await expect(prepareNativeLaunchReadiness([
      dependency('backend', events, { onPrepare: () => controller.abort() }),
      dependency('gateway', events),
    ], controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
      dependencyId: 'backend',
    })
    expect(events).toEqual([
      'prepare:backend',
      'dispose:opaque:backend',
    ])
  })

  it('rejects a pre-aborted empty preparation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(prepareNativeLaunchReadiness([], controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
      dependencyId: undefined,
    })
  })

  it('returns on timeout and owns cleanup of a late prepared result', async () => {
    vi.useFakeTimers()
    let resolvePrepare!: (value: string) => void
    const late = new Promise<string>(resolve => {
      resolvePrepare = resolve
    })
    const events: string[] = []
    const preparing = prepareNativeLaunchReadiness([{
      ...dependency('backend', events, { prepare: async () => await late }),
      prepareTimeoutMs: 10,
    }], new AbortController().signal)

    const timedOut = expect(preparing).rejects.toMatchObject({
      code: 'prepare-timeout',
      dependencyId: 'backend',
    })
    await vi.advanceTimersByTimeAsync(10)
    await timedOut
    resolvePrepare('opaque:late-backend')
    await vi.runAllTimersAsync()
    await Promise.resolve()
    expect(events).toEqual([
      'prepare:backend',
      'dispose:opaque:late-backend',
    ])
  })

  it('returns on abort and owns cleanup of a late prepared result', async () => {
    let resolvePrepare!: (value: string) => void
    const late = new Promise<string>(resolve => {
      resolvePrepare = resolve
    })
    const events: string[] = []
    const controller = new AbortController()
    const preparing = prepareNativeLaunchReadiness([
      dependency('backend', events, { prepare: async () => await late }),
    ], controller.signal)
    const cancelled = expect(preparing).rejects.toMatchObject({
      code: 'cancelled',
      dependencyId: 'backend',
    })

    controller.abort()
    await cancelled
    resolvePrepare('opaque:late-backend')
    await vi.waitFor(() => expect(events).toContain('dispose:opaque:late-backend'))
  })

  it('records cleanup failure without exposing the underlying error', async () => {
    const events: string[] = []
    const session = await prepareNativeLaunchReadiness([
      dependency('backend', events, { failDispose: true }),
    ], new AbortController().signal)

    let error: unknown
    try {
      await session.dispose()
    } catch (candidate) {
      error = candidate
    }
    expect(error).toBeInstanceOf(NativeLaunchReadinessError)
    expect(error).toMatchObject({ code: 'cleanup-failed', dependencyId: undefined })
    expect(String(error)).not.toContain('private process path')
  })

  it('shares one bounded cleanup completion across concurrent dispose calls', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    const session = await prepareNativeLaunchReadiness([{
      ...dependency('backend', events, { dispose: async () => await new Promise(() => {}) }),
      disposeTimeoutMs: 10,
    }], new AbortController().signal)

    const first = session.dispose()
    const second = session.dispose()
    expect(second).toBe(first)
    const firstFinished = expect(first).rejects.toMatchObject({ code: 'cleanup-failed' })
    const secondFinished = expect(second).rejects.toBeInstanceOf(NativeLaunchReadinessError)
    await vi.advanceTimersByTimeAsync(10)
    await firstFinished
    await secondFinished
    expect(events).toEqual([
      'prepare:backend',
      'dispose:opaque:backend',
    ])
  })

  it('rejects invalid or duplicate dependency identities before preparation', async () => {
    const events: string[] = []
    await expect(prepareNativeLaunchReadiness([
      dependency('backend', events),
      dependency('backend', events),
    ], new AbortController().signal)).rejects.toThrow('contract is invalid or duplicated')
    await expect(prepareNativeLaunchReadiness([{
      ...dependency('gateway', events),
      prepareTimeoutMs: 0,
    }], new AbortController().signal)).rejects.toThrow('contract is invalid or duplicated')
    expect(events).toEqual([])
  })
})
