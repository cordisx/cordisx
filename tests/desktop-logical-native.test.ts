import { expect, it, vi } from 'vitest'
import { desktopLogicalNativeRequests } from '../packages/cli/src/launcher/desktop-logical-native.js'

it('does not repeat a native creation whose result is unknown', async () => {
  const control = {
    nativeRequest: vi.fn(),
    createFencedLogicalDestination: vi.fn(async () => {
      throw new Error('timeout')
    }),
    releaseLogicalFence: vi.fn(async () => true),
  }
  const native = desktopLogicalNativeRequests({ control, sourceThreadId: 'source', sourceLease: 'lease' })
  await native.nativeRequest('model/list', {})
  expect(control.nativeRequest).toHaveBeenCalledWith('model/list', {}, undefined, undefined)
  await expect(native.nativeRequest('thread/start', {})).rejects.toThrow('timeout')
  await expect(native.nativeRequest('thread/start', {})).rejects.toThrow('LOGICAL_CREATION_ALREADY_ATTEMPTED')
  expect(control.createFencedLogicalDestination).toHaveBeenCalledOnce()
  expect(await native.releaseDestination()).toBe(false)
})
