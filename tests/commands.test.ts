import { describe, expect, it } from 'vitest'
import { CommandRegistry } from '../packages/cli/src/renderer/commands.js'

describe('CommandRegistry', () => {
  it('qualifies ownership, enforces public references, tracks loading, and freezes arguments', async () => {
    const registry = new CommandRegistry()
    let release: (() => void) | undefined
    let received: unknown
    registry.register('alpha', { id: 'run', title: { key: 'run' }, public: true }, async (context) => {
      received = context.arguments
      await new Promise<void>(resolve => { release = resolve })
      return 'done'
    })

    const execution = registry.execute('beta', { id: 'alpha:run', arguments: { value: 1 } }, 'button')
    expect(registry.snapshot()[0]?.running).toBe(1)
    await expect(registry.execute('beta', { id: 'alpha:run' }, 'button')).rejects.toThrow(/already running/)
    expect(Object.isFrozen(received)).toBe(true)
    release?.()
    await expect(execution).resolves.toBe('done')
    expect(registry.snapshot()[0]?.running).toBe(0)

    registry.register('alpha', { id: 'private', title: { key: 'private' } }, () => undefined)
    expect(registry.has('beta', { id: 'alpha:private' })).toBe(false)
    await expect(registry.execute('beta', { id: 'alpha:private' })).rejects.toThrow(/private/)
    registry.dispose()
  })

  it('aborts in-flight handlers on owner disposal and records non-abort failures', async () => {
    const registry = new CommandRegistry()
    let aborted = false
    const remove = registry.register('demo', { id: 'slow', title: { key: 'slow' } }, ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true })
      return new Promise(() => {})
    })
    void registry.execute('demo', { id: 'slow' })
    remove()
    expect(aborted).toBe(true)

    registry.register('demo', { id: 'fail', title: { key: 'fail' } }, () => { throw new Error('boom') })
    await expect(registry.execute('demo', { id: 'fail' })).rejects.toThrow('boom')
    expect(registry.snapshot()[0]?.lastError).toBe('boom')
    registry.dispose()
  })
})
