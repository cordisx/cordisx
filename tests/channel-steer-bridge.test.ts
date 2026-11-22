import { describe, expect, it, vi } from 'vitest'
import { dispatchNativeBridgeRequest } from '../packages/cli/assets/launcher/native-bridge-methods.mjs'

describe('native insertion bridge', () => {
  it.each([
    [{ code: -32600, message: 'no active turn to steer' }, true],
    [{ code: -32600, message: 'expected active turn id `turn-one` but found `turn-two`' }, true],
    [{ code: -32600, message: 'some other native error' }, false],
    [undefined, false],
  ])('only classifies an explicit no-effect native response %#', async (nativeError, rejected) => {
    const write = vi.fn(async () => {})
    const error = Object.assign(new Error('failure'), nativeError ? { nativeError } : {})
    const ports = {
      object: value => value,
      logicalWriteFence: { owns: () => true },
      uncertainSwitches: new Map(),
      configuredOverrides: value => value,
      nativeCall: async () => {
        throw error
      },
      write,
      control: {},
      stop: () => {},
    }
    expect(dispatchNativeBridgeRequest({
      type: 'native-request',
      id: 'request',
      method: 'turn/steer',
      params: { threadId: 'session', expectedTurnId: 'turn-one' },
    }, ports)).toBe(true)
    await vi.waitFor(() => expect(write).toHaveBeenCalled())
    expect(write.mock.calls[0]![1]).toEqual(
      rejected
        ? { id: 'request', ok: true, value: { cordisxSteerRejected: true } }
        : { id: 'request', ok: false },
    )
  })
})
