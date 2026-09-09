import { describe, expect, it } from 'vitest'
import {
  NotificationCenter,
  type NotificationOwner,
  type NotificationRule,
} from '../packages/cli/src/renderer/notifications/model.js'

function fixture() {
  let now = 100000
  let saved: readonly NotificationRule[] = []
  const storage = {
    read: () => saved,
    write: (next: readonly NotificationRule[]) => {
      saved = structuredClone(next)
    },
  }
  const center = new NotificationCenter(storage, () => now)
  let active = true
  const owner: NotificationOwner = {
    key: 'source/a',
    pluginId: 'a',
    active: () => active,
    presentation: () => ({ name: 'Plugin A' }),
  }
  const binding = center.bind(owner)
  return {
    center,
    owner,
    binding,
    storage,
    advance: (ms: number) => {
      now += ms
    },
    retire: () => {
      active = false
    },
  }
}
const error = { kind: 'connection.failed', type: 'error' as const, message: 'Connection failed' }

describe('owner-bound notifications', () => {
  it('coalesces one kind but isolates plugin sources, handles and retirement', () => {
    const f = fixture()
    const handle = f.binding.api.show(error)
    f.binding.api.show({ ...error, message: 'Translated message' })
    const other = f.center.bind({ ...f.owner, key: 'source/b' })
    other.api.show(error)
    expect(f.center.visible().map(e => e.count)).toEqual([2, 1])
    handle.dismiss()
    handle.dismiss()
    expect(f.center.visible()).toHaveLength(1)
    f.binding.dispose()
    f.binding.api.show(error)
    expect(f.center.visible()).toHaveLength(1)
    other.dispose()
    expect(f.center.visible()).toHaveLength(0)
  })
  it('expires only visible unpaused notices and retains errors', () => {
    const f = fixture()
    for (let i = 0; i < 4; i++) f.binding.api.show({ kind: `saved.${i}`, type: 'success', message: 'Saved' })
    expect(f.center.pending()).toBe(1)
    f.center.visible()[0]!.paused = true
    for (let i = 0; i < 3; i++) f.center.tick(1000)
    expect(f.center.visible().map(e => e.options.kind)).toEqual(['saved.0', 'saved.3'])
    expect(f.center.visible()[1]!.remaining).toBe(3000)
    f.center.tick(1000, true)
    expect(f.center.visible()[1]!.remaining).toBe(3000)
    f.binding.api.show(error)
    for (let i = 0; i < 20; i++) f.center.tick(1000)
    expect(f.center.visible().some(e => e.options.type === 'error')).toBe(true)
  })
  it('suppresses queued, visible and future messages, persists and restores rules', () => {
    const f = fixture()
    for (let i = 0; i < 5; i++) f.binding.api.show({ ...error, kind: `failed.${i}` })
    f.center.mute(f.center.visible()[0]!, 'plugin')
    expect(f.center.visible()).toHaveLength(0)
    expect(f.center.pending()).toBe(0)
    f.binding.api.show(error)
    expect(f.center.visible()).toHaveLength(0)
    const restored = new NotificationCenter(f.storage)
    restored.bind(f.owner).api.show(error)
    expect(restored.visible()).toHaveLength(0)
    f.center.undo()
    f.binding.api.show(error)
    expect(f.center.visible()).toHaveLength(1)
    f.center.mute(f.center.visible()[0]!, 'hour')
    f.advance(3600001)
    f.binding.api.show(error)
    expect(f.center.visible()).toHaveLength(1)
  })
  it('mutes by kind, leaves other owners and categories available', () => {
    const f = fixture()
    f.binding.api.show(error)
    f.center.mute(f.center.visible()[0]!, 'kind')
    f.binding.api.show({ ...error, message: 'Other language' })
    f.binding.api.show({ ...error, kind: 'save.failed' })
    f.center.bind({ ...f.owner, key: 'other-source/a' }).api.show(error)
    expect(f.center.visible().map(e => e.options.kind)).toEqual(['save.failed', 'connection.failed'])
  })
  it('fences async actions, aborts them on dismiss, and preserves failures for retry', async () => {
    const f = fixture()
    let calls = 0
    let signal: AbortSignal | undefined
    let done!: () => void
    f.binding.api.show({
      ...error,
      action: {
        label: 'Retry',
        run: s => {
          calls++
          signal = s
          return new Promise<void>(resolve => {
            done = resolve
          })
        },
      },
    })
    const entry = f.center.visible()[0]!
    const running = f.center.invoke(entry, 'Failed')
    await f.center.invoke(entry, 'Failed')
    expect(calls).toBe(1)
    f.binding.dispose()
    expect(signal?.aborted).toBe(true)
    done()
    await running
    expect(f.center.visible()).toHaveLength(0)
    const binding = f.center.bind(f.owner)
    binding.api.show({
      ...error,
      action: {
        label: 'Retry',
        run: () => {
          throw new Error('private error')
        },
      },
    })
    await f.center.invoke(f.center.visible()[0]!, 'Please retry')
    expect(f.center.visible()[0]!.actionError).toBe('Please retry')
    f.retire()
    f.center.tick(100)
    expect(f.center.visible()).toHaveLength(0)
  })
  it('does not claim persistence on write failure and rejects invalid input', () => {
    const center = new NotificationCenter({
      read: () => [],
      write: () => {
        throw new Error('blocked')
      },
    })
    const { owner } = fixture()
    const { api } = center.bind(owner)
    expect(() => api.show({ ...error, kind: undefined as unknown as string })).toThrow()
    expect(() => api.show({ ...error, kind: 'dynamic user message!' })).toThrow()
    api.show(error)
    center.mute(center.visible()[0]!, 'plugin')
    expect(center.persistenceError).toBe(true)
    api.show(error)
    expect(center.visible()).toHaveLength(0)
  })
})
