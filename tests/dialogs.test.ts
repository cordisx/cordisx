import { describe, expect, it, vi } from 'vitest'
import { DialogCenter } from '../packages/cli/src/renderer/dialogs/model.js'

function fixture() {
  const center = new DialogCenter()
  const report = vi.fn()
  const owner = { key: 'a/source', name: () => 'A', active: () => true, report }
  const binding = center.bind(owner)
  binding.api.register('body', () => {})
  const open = (instanceKey?: string) =>
    binding.api.open({
      kind: 'room.details',
      title: 'Room',
      content: { id: 'body' },
      ...(instanceKey ? { instanceKey } : {}),
    })
  return { center, owner, binding, open, report }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('owner-bound dialogs', () => {
  it('queues normal modals, deduplicates instances and isolates owners', async () => {
    const f = fixture()
    const first = f.open('room-1')
    expect(f.open('room-1')).toBe(first)
    const second = f.open('room-2')
    const other = f.center.bind({ ...f.owner, key: 'b/source' })
    other.api.register('body', () => {})
    other.api.open({ kind: 'room.details', title: 'Other', instanceKey: 'room-1', content: { id: 'body' } })
    expect(f.center.all()).toHaveLength(3)
    expect(f.center.visible()).toHaveLength(1)
    await first.close()
    expect((await first.result).status).toBe('closed')
    expect(f.center.visible()[0]!.handle).toBe(second)
    f.binding.dispose()
    expect(f.center.all()).toHaveLength(1)
    expect(await second.result).toEqual({ status: 'disposed' })
  })
  it('vetoes close, serializes guards, and resolves a child confirmation', async () => {
    const f = fixture()
    const gate = deferred()
    const handle = f.open()
    handle.update({
      title: 'Unsaved',
      beforeClose: async () => {
        await gate.promise
        return false
      },
    })
    const closing = handle.close('escape')
    expect(await handle.close('close-button')).toBe(false)
    gate.resolve()
    expect(await closing).toBe(false)
    const child = f.binding.api.confirm({
      kind: 'discard',
      title: 'Discard?',
      confirmLabel: 'Discard',
      run: () => {},
      parent: handle,
    })
    expect(f.center.visible()).toHaveLength(2)
    expect(await handle.close()).toBe(false)
    const entry = f.center.visible()[1]!
    await f.center.run(entry, entry.chrome.footer!.primaryAction!)
    expect(await child).toEqual({ status: 'completed', actionId: 'confirm' })
    expect(handle.signal.aborted).toBe(false)
    f.binding.dispose()
  })
  it('prevents duplicate submits, reports failure, retries and aborts on unload', async () => {
    const f = fixture()
    const gate = deferred()
    let fail = true
    const run = vi.fn(async () => {
      await gate.promise
      if (fail) throw new Error('secret backend payload')
    })
    const result = f.binding.api.confirm({ kind: 'save', title: 'Save?', confirmLabel: 'Save', run })
    const entry = f.center.visible()[0]!
    const action = entry.chrome.footer!.primaryAction!
    const pending = f.center.run(entry, action)
    await f.center.run(entry, action)
    expect(run).toHaveBeenCalledTimes(1)
    gate.resolve()
    await pending
    expect(f.report).toHaveBeenCalledWith('save')
    expect(entry.closed).toBe(false)
    fail = false
    await f.center.run(entry, action)
    expect(await result).toEqual({ status: 'completed', actionId: 'confirm' })
    expect(entry.abort.signal.aborted).toBe(true)
    const handle = f.open()
    f.binding.dispose()
    expect(handle.signal.aborted).toBe(true)
    expect(await handle.result).toEqual({ status: 'disposed' })
    expect(await f.open().result).toEqual({ status: 'disposed' })
  })
  it('bounds queues and never leaves unavailable requests pending', async () => {
    const f = fixture()
    for (let index = 0; index < 5; index++) f.open()
    expect(await f.open().result).toEqual({ status: 'queue-full' })
    expect(await f.binding.api.open({ kind: 'missing', title: 'Missing', content: { id: 'absent' } }).result).toEqual({
      status: 'unavailable',
    })
    f.center.dispose()
    expect(f.center.all()).toEqual([])
  })
  it('rejects JSX chrome, duplicate actions and cross-owner child parents', async () => {
    const f = fixture()
    expect(() => f.binding.api.open({ kind: 'bad', title: {} as string, content: { id: 'body' } })).toThrow()
    const handle = f.open()
    expect(() =>
      handle.update({
        title: 'x',
        headerActions: Array.from({ length: 2 }, () => ({ id: 'same', label: 'Same', onAction: () => {} })),
      })
    ).toThrow()
    const other = f.center.bind({ ...f.owner, key: 'b' })
    expect(await other.api.confirm({ kind: 'x', title: 'X', confirmLabel: 'Yes', parent: handle, run: () => {} }))
      .toEqual({ status: 'unavailable' })
    f.center.dispose()
  })
  it('retires registered and declarative views without disposing sibling dialogs', async () => {
    const f = fixture()
    const unregister = f.binding.api.register('other', () => {})
    const handle = f.binding.api.open({ kind: 'other', title: 'Other', content: { id: 'other' } })
    const sibling = f.open()
    unregister()
    expect(await handle.result).toEqual({ status: 'disposed' })
    expect(sibling.signal.aborted).toBe(false)
    f.binding.disposeBody(sibling)
    expect(await sibling.result).toEqual({ status: 'disposed' })
  })
  it('keeps separate registrations of the same mount independent', async () => {
    const f = fixture()
    const mount = () => {}
    const unregister = f.binding.api.register('one', mount)
    f.binding.api.register('two', mount)
    const first = f.binding.api.open({ kind: 'one', title: 'One', content: { id: 'one' } })
    const second = f.binding.api.open({ kind: 'two', title: 'Two', content: { id: 'two' } })
    unregister()
    expect(await first.result).toEqual({ status: 'disposed' })
    expect(second.signal.aborted).toBe(false)
    f.center.dispose()
  })
  it('keeps a close guard locked when an in-flight action finishes', async () => {
    const f = fixture()
    const guard = deferred()
    const task = deferred()
    const handle = f.open()
    const beforeClose = vi.fn(async () => {
      await guard.promise
      return false
    })
    handle.update({ title: 'Busy', beforeClose })
    const entry = f.center.visible()[0]!
    const run = f.center.run(entry, { id: 'work', label: 'Work', onAction: () => task.promise })
    const close = handle.close()
    task.resolve()
    await run
    expect(await handle.close()).toBe(false)
    expect(beforeClose).toHaveBeenCalledTimes(1)
    guard.resolve()
    await close
    expect(entry.closing).toBe(false)
    expect(entry.busy).toBeUndefined()
    f.center.dispose()
  })
  it('snapshots chrome so later caller mutation cannot replace Host labels or layout', () => {
    const f = fixture()
    const action = { id: 'share', label: 'Share', onAction: () => {} }
    const footer = { status: 'Ready', primaryAction: action }
    const handle = f.open()
    handle.update({ title: 'Room', footer, headerActions: [] })
    action.label = 'Mutated'
    footer.status = 'Changed'
    expect(f.center.visible()[0]!.chrome.footer!.primaryAction!.label).toBe('Share')
    expect(f.center.visible()[0]!.chrome.footer!.status).toBe('Ready')
    f.center.dispose()
  })
})
