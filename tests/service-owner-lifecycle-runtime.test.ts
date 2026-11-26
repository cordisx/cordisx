import { describe, expect, it, vi } from 'vitest'
import { ServiceOwnerLifecycleRuntime } from '../packages/cli/src/cli/service-owner-lifecycle-runtime.js'
import {
  includeTerminalLifecycleFence,
  terminalLifecycleAffectedPlugins,
} from '../packages/cli/src/cli/service-owner-lifecycle-fence.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  PluginRuntimePreflight,
} from '../packages/cli/src/launcher/plugin-lifecycle-model.js'

const preflight = { transactionId: 'tx' } as PluginRuntimePreflight
const mutation = { transactionId: 'tx' } as PluginRuntimeMutation

function fixture() {
  let current = true
  const fence = {
    isCurrent: () => current,
    cancel: vi.fn(() => true),
    abort: vi.fn(() => true),
    finish: vi.fn(async () => true),
    fence: vi.fn(() => current = false),
  }
  const runtime = {
    preflight: vi.fn(async () => {}),
    prepare: vi.fn(() => ({ transactionEpoch: 'epoch', expectedRegistryEpoch: 0 })),
    stage: vi.fn(async () => undefined),
    publish: vi.fn(async () => ({})),
    complete: vi.fn(async () => ({})),
    finalize: vi.fn(async () => {}),
    rollback: vi.fn(async () => ({})),
    adoptRecoveredActivation: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    terminal: vi.fn(),
  }
  const wrapped = new ServiceOwnerLifecycleRuntime({
    runtime: runtime as unknown as PluginLifecycleRuntime,
    reserve: () => fence,
  })
  return { fence, runtime, wrapped, disconnect: () => current = false }
}

describe('service owner lifecycle coordination', () => {
  it('includes dependents when a plugin generation changes', () => {
    const base = { id: 'base', dependencies: [], enabled: true }
    const dependent = { id: 'dependent', dependencies: [{ id: 'base' }], enabled: true }
    const other = { id: 'other', dependencies: [], enabled: true }
    const input = {
      targetId: 'base',
      previous: { plugins: [base, dependent, other] },
      candidate: { plugins: [{ ...base, enabled: false }, { ...dependent, enabled: false }, other] },
    } as unknown as PluginRuntimePreflight
    expect(new Set(terminalLifecycleAffectedPlugins(input))).toEqual(new Set(['base', 'dependent']))
  })

  it('keeps terminal admission reserved until Manager adoption finishes', async () => {
    let finish!: (value: boolean) => void
    const manager = {
      isCurrent: () => true,
      cancel: vi.fn(() => true),
      abort: vi.fn(() => true),
      finish: vi.fn(() => new Promise<boolean>(resolve => finish = resolve)),
      fence: vi.fn(),
    }
    const terminal = { isCurrent: () => true, release: vi.fn(() => true), fence: vi.fn() }
    const combined = includeTerminalLifecycleFence(terminal, manager)
    const completion = combined.finish()
    expect(terminal.release).not.toHaveBeenCalled()
    finish(true)
    expect(await completion).toBe(true)
    expect(terminal.release).toHaveBeenCalledOnce()
  })

  it('fences terminal admission if Manager adoption is not confirmed', async () => {
    const manager = {
      isCurrent: () => true,
      cancel: vi.fn(() => true),
      abort: vi.fn(() => true),
      finish: vi.fn(async () => false),
      fence: vi.fn(),
    }
    const terminal = { isCurrent: () => true, release: vi.fn(() => true), fence: vi.fn() }
    expect(await includeTerminalLifecycleFence(terminal, manager).finish()).toBe(false)
    expect(terminal.release).not.toHaveBeenCalled()
    expect(terminal.fence).toHaveBeenCalledOnce()
    expect(manager.fence).toHaveBeenCalledOnce()
  })

  it('starts the underlying preflight synchronously when no Manager needs a reservation', async () => {
    let managerAppeared = false
    const check = vi.fn(async () => expect(managerAppeared).toBe(false))
    const wrapped = new ServiceOwnerLifecycleRuntime({
      runtime: { preflight: check } as unknown as PluginLifecycleRuntime,
      reserve: () => undefined,
    })
    const pending = wrapped.preflight(preflight)
    managerAppeared = true
    await pending
    expect(check).toHaveBeenCalledOnce()
  })

  it('starts preflight synchronously when only terminal clients are reserved', async () => {
    let managerAppeared = false
    const check = vi.fn(async () => expect(managerAppeared).toBe(false))
    const terminal = { isCurrent: () => true, release: () => true, fence: () => {} }
    const wrapped = new ServiceOwnerLifecycleRuntime({
      runtime: { preflight: check } as unknown as PluginLifecycleRuntime,
      reserve: () => includeTerminalLifecycleFence(terminal),
    })
    const pending = wrapped.preflight(preflight)
    managerAppeared = true
    await pending
    expect(check).toHaveBeenCalledOnce()
  })

  it('holds the reservation through publication and releases it only after finalization', async () => {
    const f = fixture()
    await f.wrapped.preflight(preflight)
    f.wrapped.prepare('tx')
    await f.wrapped.stage(mutation)
    await f.wrapped.publish('tx')
    await f.wrapped.complete('tx')
    expect(f.fence.finish).not.toHaveBeenCalled()
    await f.wrapped.finalize('tx')
    expect(f.fence.finish).toHaveBeenCalledOnce()
    expect(f.runtime.terminal).not.toHaveBeenCalled()
  })

  it('cancels an undispatched preflight and fences a failed cancellation', async () => {
    const first = fixture()
    first.runtime.preflight.mockRejectedValueOnce(new Error('rejected'))
    await expect(first.wrapped.preflight(preflight)).rejects.toThrow('rejected')
    expect(first.fence.cancel).toHaveBeenCalledOnce()
    expect(first.runtime.terminal).not.toHaveBeenCalled()
    const second = fixture()
    second.runtime.preflight.mockRejectedValueOnce(new Error('rejected'))
    second.fence.cancel.mockReturnValueOnce(false)
    await expect(second.wrapped.preflight(preflight)).rejects.toThrow('rejected')
    expect(second.fence.fence).toHaveBeenCalledOnce()
    expect(second.runtime.terminal).toHaveBeenCalledOnce()
  })

  it('keeps the fence until rollback adoption is confirmed', async () => {
    const f = fixture()
    await f.wrapped.preflight(preflight)
    f.wrapped.prepare('tx')
    await f.wrapped.stage(mutation)
    await f.wrapped.rollback('tx')
    expect(f.fence.finish).not.toHaveBeenCalled()
    await f.wrapped.adoptRecoveredActivation({} as never, 2)
    expect(f.fence.finish).toHaveBeenCalledOnce()
  })

  it('fences a failed rollback or a disconnected participant', async () => {
    const first = fixture()
    await first.wrapped.preflight(preflight)
    first.wrapped.prepare('tx')
    first.runtime.rollback.mockRejectedValueOnce(new Error('rollback failed'))
    await expect(first.wrapped.rollback('tx')).rejects.toThrow('rollback failed')
    expect(first.fence.fence).toHaveBeenCalledOnce()
    expect(first.runtime.terminal).toHaveBeenCalledOnce()
    const second = fixture()
    await second.wrapped.preflight(preflight)
    second.wrapped.prepare('tx')
    second.disconnect()
    await expect(second.wrapped.stage(mutation)).rejects.toThrow('manager-lifecycle-fence-unavailable')
    expect(second.fence.fence).toHaveBeenCalledOnce()
    expect(second.runtime.terminal).toHaveBeenCalledOnce()
  })

  it('fences the owner when post-finalization adoption cannot be confirmed', async () => {
    const f = fixture()
    await f.wrapped.preflight(preflight)
    f.wrapped.prepare('tx')
    await f.wrapped.stage(mutation)
    await f.wrapped.publish('tx')
    await f.wrapped.complete('tx')
    f.fence.finish.mockResolvedValueOnce(false)
    await expect(f.wrapped.finalize('tx')).rejects.toThrow('manager-lifecycle-fence-unavailable')
    expect(f.fence.fence).toHaveBeenCalledOnce()
    expect(f.runtime.terminal).toHaveBeenCalledOnce()
  })

  it('allows the existing bounded finalization retry without releasing the fence early', async () => {
    const f = fixture()
    await f.wrapped.preflight(preflight)
    f.wrapped.prepare('tx')
    f.runtime.finalize.mockRejectedValueOnce(new Error('retry'))
    await expect(f.wrapped.finalize('tx')).rejects.toThrow('retry')
    expect(f.fence.finish).not.toHaveBeenCalled()
    await f.wrapped.finalize('tx')
    expect(f.fence.finish).toHaveBeenCalledOnce()
  })
})
