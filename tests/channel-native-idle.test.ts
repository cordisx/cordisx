import { describe, expect, it, vi } from 'vitest'
import { channelNativeIdle } from '../packages/cli/src/launcher/channel-native-idle.js'

describe('Channel native idle readback', () => {
  it('accepts an error only if the latest turn failed and the thread remains in error', async () => {
    let status = 'systemError', turn = 'failed', reads = 0
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === 'thread/read') {
        reads++
        return { thread: { id: 'chat', status: { type: status } } }
      }
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: turn }] }
      throw new Error('unexpected request')
    })
    expect(await channelNativeIdle({ nativeRequest }, 'chat')).toBeDefined()
    expect(reads).toBe(2)
    turn = 'inProgress'
    expect(await channelNativeIdle({ nativeRequest }, 'chat')).toBeUndefined()
    turn = 'failed'
    status = 'active'
    expect(await channelNativeIdle({ nativeRequest }, 'chat')).toBeUndefined()
    status = 'unknown'
    expect(await channelNativeIdle({ nativeRequest }, 'chat')).toBeUndefined()
    status = 'systemError'
    nativeRequest.mockImplementationOnce(async () => ({ thread: { id: 'chat', status: { type: 'systemError' } } }))
      .mockImplementationOnce(async () => ({ data: [{ id: 'turn', status: 'failed' }] }))
      .mockImplementationOnce(async () => ({ thread: { id: 'chat', status: { type: 'active' } } }))
    expect(await channelNativeIdle({ nativeRequest }, 'chat')).toBeUndefined()
  })
})
