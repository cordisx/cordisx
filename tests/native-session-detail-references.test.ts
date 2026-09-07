import { describe, expect, it, vi } from 'vitest'
import { NativeSessionDetailReferences } from '../packages/cli/src/renderer/native-session-detail-references.js'

const owner = { pluginId: 'file:///plugins/a.ts:chatroom', generation: 1 }
const foreign = { pluginId: 'file:///plugins/b.ts:chatroom', generation: 1 }
const mapping = { threadId: 'private-native-thread', revision: 1 }
const live = () => true
const permitted = async () => true

async function reference(provider: NativeSessionDetailReferences) {
  const result = await provider.get(owner, 'historical-session', live)
  expect(result.status).toBe('accepted')
  if (result.status !== 'accepted') throw new Error('reference unavailable')
  expect(JSON.stringify(result)).not.toContain(mapping.threadId)
  return result.target
}

describe('historical detail capabilities', () => {
  it('revalidates exact source, generation, permission and mapping; stale targets never navigate', async () => {
    const provider = new NativeSessionDetailReferences()
    let current = { ...mapping }
    const read = vi.fn(async () => current)
    const unregister = provider.register(owner, { active: live, read })
    const navigate = vi.fn()
    const target = await reference(provider)
    await expect(provider.open(foreign, target, live, permitted, navigate)).resolves.toMatchObject({
      status: 'unavailable',
    })
    await expect(provider.open({ ...owner, generation: 2 }, target, live, permitted, navigate)).resolves.toMatchObject({
      status: 'unavailable',
    })
    await expect(provider.open(owner, target, live, async () => false, navigate)).resolves.toEqual({
      status: 'denied',
      code: 'permission-denied',
    })
    expect(navigate).not.toHaveBeenCalled()
    await expect(provider.open(owner, target, live, permitted, navigate)).resolves.toEqual({
      status: 'accepted',
      code: 'opened',
    })
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      { kind: 'host', ref: `codex-thread:${mapping.threadId}` },
      'historical-session',
    )
    current = { ...current, revision: 2 }
    await expect(provider.open(owner, target, live, permitted, navigate)).resolves.toEqual({
      status: 'unavailable',
      code: 'stale-reference',
    })
    const fresh = await reference(provider)
    expect(fresh).not.toEqual(target)
    unregister()
    provider.register(owner, { active: live, read })
    await expect(provider.open(owner, fresh, live, permitted, navigate)).resolves.toMatchObject({
      status: 'unavailable',
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    provider.dispose()
  })

  it('fences async issuance and open against connection, owner and mapping replacement', async () => {
    const provider = new NativeSessionDetailReferences()
    let connected = true
    const active = () => connected
    const read = vi.fn(async () => ({ ...mapping }))
    provider.register(owner, { active: live, read })
    read.mockImplementationOnce(async () => {
      connected = false
      return mapping
    })
    await expect(provider.get(owner, 'historical-session', active)).resolves.toMatchObject({ status: 'unavailable' })
    connected = true
    read.mockResolvedValueOnce(mapping).mockResolvedValueOnce({ ...mapping, revision: 2 })
    await expect(provider.get(owner, 'historical-session', active)).resolves.toMatchObject({ status: 'unavailable' })
    const result = await provider.get(owner, 'historical-session', active)
    if (result.status !== 'accepted') throw new Error('reference unavailable')
    const navigate = vi.fn()
    await expect(provider.open(owner, result.target, active, async () => {
      connected = false
      return true
    }, navigate)).resolves.toMatchObject({ status: 'unavailable' })
    expect(navigate).not.toHaveBeenCalled()
    connected = true
    read.mockImplementationOnce(async () => {
      provider.register(owner, { active: live, read: async () => mapping })
      return mapping
    })
    await expect(provider.open(owner, result.target, active, permitted, navigate)).resolves.toMatchObject({
      status: 'unavailable',
    })
    expect(navigate).not.toHaveBeenCalled()
    provider.dispose()
  })

  it('keeps issued references invalid after disconnect even when a new read is available', async () => {
    const provider = new NativeSessionDetailReferences()
    let epoch = 1
    provider.register(owner, { active: live, read: async () => mapping })
    const first = await provider.get(owner, 'historical-session', () => epoch === 1)
    if (first.status !== 'accepted') throw new Error('reference unavailable')
    epoch = 2
    const next = await provider.get(owner, 'historical-session', () => epoch === 2)
    if (next.status !== 'accepted') throw new Error('reference unavailable')
    const navigate = vi.fn()
    expect(next.target).not.toEqual(first.target)
    await expect(provider.open(owner, first.target, live, permitted, navigate)).resolves.toMatchObject({
      status: 'unavailable',
    })
    expect(navigate).not.toHaveBeenCalled()
    provider.dispose()
  })
})
