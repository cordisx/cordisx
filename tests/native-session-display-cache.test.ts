import { describe, expect, it } from 'vitest'
import { NativeSessionDisplayCache } from '../packages/cli/src/renderer/native-session-display-cache.js'

describe('native session display cache', () => {
  it('isolates host and thread, and does not rewrite identical values', () => {
    const data = new Map<string, string>()
    let writes = 0
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes++
        data.set(key, value)
      },
    } as Storage
    let time = 1
    const cache = new NativeSessionDisplayCache(storage, () => time++)
    const value = { providerId: 'provider', model: 'model', reasoningEffort: 'high', serviceTier: 'priority' as const }
    cache.write('local', 'chat', value)
    cache.write('local', 'chat', value)
    expect(writes).toBe(1)
    expect(cache.read('local', 'chat')).toEqual({ ...value, updatedAt: 1 })
    cache.writeSelection('local', {
      available: true,
      busy: false,
      threadId: 'chat',
      modelProvider: 'provider',
      model: 'other',
      serviceTier: null,
    }, false)
    expect(cache.read('local', 'chat')).toEqual({
      providerId: 'provider',
      model: 'other',
      serviceTier: null,
      updatedAt: 2,
    })
    expect(cache.read('remote', 'chat')).toBeUndefined()
    expect(cache.read('local', 'other')).toBeUndefined()
    cache.write('local', 'chat', { ...value, serviceTier: null })
    expect(cache.read('local', 'chat')?.updatedAt).toBe(3)
  })

  it('persists partial labels and keeps draft display separate from any thread', () => {
    const values = new Map<string, string>()
    const cache = new NativeSessionDisplayCache({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
    } as Storage, () => 1)
    cache.writeSelection('local', { available: true, busy: false, modelProvider: 'p', model: 'm' }, false)
    expect(cache.readSelection('local', { available: false, busy: false })).toEqual({
      providerId: 'p',
      model: 'm',
      updatedAt: 1,
    })
    expect(cache.read('local', 'draft')).toBeUndefined()
    cache.writeSelection('local', { available: true, busy: false, modelProvider: 'p', model: 'locked' }, true)
    expect(cache.read('local', undefined)?.model).toBe('m')
    cache.write('local', 'chat', { providerId: 'p', model: 'm', reasoningEffort: 'high', serviceTier: 'priority' })
    cache.writeSelection(
      'local',
      { available: true, busy: false, threadId: 'chat', modelProvider: 'p', model: 'm' },
      false,
    )
    expect(cache.read('local', 'chat')).toMatchObject({ reasoningEffort: 'high', serviceTier: 'priority' })
  })

  it('ignores invalid stored values and storage failures', () => {
    const cache = new NativeSessionDisplayCache({
      getItem: () => '{',
      setItem: () => {
        throw new Error('denied')
      },
    } as unknown as Storage)
    expect(cache.read('local', 'chat')).toBeUndefined()
    expect(() => cache.write('local', 'chat', { providerId: 'p', model: 'm', serviceTier: null })).not.toThrow()
  })
})
