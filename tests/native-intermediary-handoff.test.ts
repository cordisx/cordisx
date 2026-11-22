import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createNativeIntermediaryWriter } from '../packages/cli/assets/launcher/native-intermediary-writer.mjs'
import { NativeLogicalWriteFence } from '../packages/cli/assets/launcher/native-logical-write-fence.mjs'

describe('native intermediary checkpoint write guard', () => {
  it('writes only the reserved handoff and releases its authorization after the write', async () => {
    const stream = new PassThrough()
    let output = ''
    stream.on('data', chunk => {
      output += chunk.toString()
    })
    const calls: string[] = []
    const controlCall = vi.fn(async (type: string, value: { guardId?: string }) => {
      calls.push(type)
      if (type === 'logical-handoff-status') {
        return {
          state: 'pending',
          marker: 'marker',
          handoff: 'checkpoint',
          digest: 'a'.repeat(64),
        }
      }
      if (type === 'logical-handoff-authorize') return { state: 'authorized', lease: value.guardId }
      return true
    })
    const fence = new NativeLogicalWriteFence()
    const writer = createNativeIntermediaryWriter({
      nativeStream: () => stream,
      fence,
      initializing: vi.fn(),
      issued: vi.fn(),
      handoffEnabled: () => true,
      controlCall,
    })
    await writer(stream, {
      id: 'one',
      method: 'turn/start',
      params: { threadId: 'target', input: [{ text: 'marker\ncheckpoint' }] },
    })
    expect(JSON.parse(output).params.input[0].text).toBe('marker\ncheckpoint')
    expect(calls).toEqual(['logical-handoff-status', 'logical-handoff-authorize', 'logical-handoff-release'])
    stream.destroy()
  })

  it('rejects an unrelated or stale write without leaving a phantom native write fence', async () => {
    const stream = new PassThrough()
    const controlCall = vi.fn(async () => ({
      state: 'pending',
      marker: 'marker',
      handoff: 'checkpoint',
      digest: 'a'.repeat(64),
    }))
    const fence = new NativeLogicalWriteFence()
    const writer = createNativeIntermediaryWriter({
      nativeStream: () => stream,
      fence,
      initializing: vi.fn(),
      issued: vi.fn(),
      handoffEnabled: () => true,
      controlCall,
    })
    await expect(writer(stream, {
      id: 'unrelated',
      method: 'turn/start',
      params: { threadId: 'target', input: [{ text: 'checkpoint' }] },
    })).rejects.toMatchObject({ code: 'CONTINUATION_PENDING' })
    expect(controlCall).toHaveBeenCalledTimes(1)
    expect(fence.acquire('target')).toBeTruthy()
    stream.destroy()
  })

  it('cancels a possibly late authorization when its control response is lost', async () => {
    const stream = new PassThrough(), calls: Array<{ type: string; value: Record<string, unknown> }> = []
    const controlCall = vi.fn(async (type: string, value: Record<string, unknown>) => {
      calls.push({ type, value })
      if (type === 'logical-handoff-status') {
        return { state: 'pending', marker: 'marker', handoff: 'checkpoint', digest: 'a'.repeat(64) }
      }
      if (type === 'logical-handoff-authorize') throw new Error('response lost')
      return true
    })
    const fence = new NativeLogicalWriteFence()
    const writer = createNativeIntermediaryWriter({
      nativeStream: () => stream,
      fence,
      initializing: vi.fn(),
      issued: vi.fn(),
      handoffEnabled: () => true,
      controlCall,
    })
    await expect(writer(stream, {
      id: 'lost',
      method: 'turn/start',
      params: { threadId: 'target', input: [{ text: 'marker\ncheckpoint' }] },
    })).rejects.toMatchObject({ code: 'CONTINUATION_PENDING' })
    expect(calls.map(call => call.type)).toEqual([
      'logical-handoff-status',
      'logical-handoff-authorize',
      'logical-handoff-release',
    ])
    expect(calls[2]!.value.lease).toBe(calls[1]!.value.guardId)
    expect(fence.acquire('target')).toBeTruthy()
    stream.destroy()
  })
})
