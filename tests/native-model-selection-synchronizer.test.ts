import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeModelSelectionSynchronizer } from '../packages/cli/src/renderer/native-model-selection-synchronizer.js'

afterEach(() => vi.useRealTimers())

describe('native selection acknowledgment', () => {
  it('waits for the requested effort even when the native model already matches', async () => {
    vi.useFakeTimers()
    const control = { model: 'deepseek-flash', reasoningEffort: 'high', selectModel: vi.fn(async () => {}) }
    const done = vi.fn()
    const selection = new NativeModelSelectionSynchronizer().synchronize({
      scopeKey: 'thread-1',
      model: control.model,
      effort: 'max',
      verifyEffort: true,
      readControl: () => control,
      assertCurrent() {},
    }).then(done)
    await vi.advanceTimersByTimeAsync(25)
    expect(done).not.toHaveBeenCalled()
    expect(control.selectModel).toHaveBeenCalledWith('deepseek-flash', 'max')
    control.reasoningEffort = 'max'
    await vi.advanceTimersByTimeAsync(25)
    await selection
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('does not accept optimistic native values after navigation', async () => {
    let current = true
    const control = {
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      selectModel: vi.fn(async () => {
        current = false
        control.reasoningEffort = 'max'
      }),
    }
    await expect(new NativeModelSelectionSynchronizer().synchronize({
      scopeKey: 'thread-1',
      model: control.model,
      effort: 'max',
      verifyEffort: true,
      readControl: () => control,
      assertCurrent() {
        if (!current) throw new Error('navigated')
      },
    })).rejects.toThrow('navigated')
  })
})
