import { expect, it, vi } from 'vitest'
import {
  createNativeLogicalNavigation,
  openNativeLogicalSource,
  readNativeLogicalPrevious,
} from '../packages/cli/src/renderer/native-logical-source-navigation.js'

it('discards an earlier boundary when the composer changes during the read', async () => {
  const scope = { targetId: 'window', rendererGeneration: 'generation', navigationGeneration: 1, threadId: 'target' }
  let current = scope
  const input = {
    scope,
    current: () => current,
    connected: () => true,
    channel: {
      logicalPrevious: async () => {
        current = { ...scope, threadId: 'other' }
        return 'source'
      },
    } as never,
  }
  expect(await readNativeLogicalPrevious(input)).toBeUndefined()
})

it('does not read an earlier boundary for a stale displayed thread', async () => {
  const scope = { targetId: 'window', rendererGeneration: 'generation', navigationGeneration: 1, threadId: 'new' }
  const read = vi.fn(async () => 'source')
  const navigation = createNativeLogicalNavigation({
    channel: () => ({ logicalPrevious: read }) as never,
    scope: () => scope,
    connected: () => true,
    navigate: () => undefined,
  })
  expect(await navigation.previous('old')).toBeUndefined()
  expect(read).not.toHaveBeenCalled()
})

it('navigates only after Host authorization and a matching live composer', async () => {
  const scope = { targetId: 'window', rendererGeneration: 'generation', navigationGeneration: 1, threadId: 'target' }
  let current = scope, connected = true
  const navigate = vi.fn(async () => {})
  const authorize = vi.fn(async () => true)
  const input = {
    channel: { logicalSourceNavigation: authorize } as never,
    scope,
    current: () => current,
    connected: () => connected,
    navigate,
  }
  expect(await openNativeLogicalSource(input, 'source')).toBe('accepted')
  expect(navigate).toHaveBeenCalledWith('source')
  authorize.mockResolvedValueOnce(false)
  expect(await openNativeLogicalSource(input, 'source')).toBe('unavailable')
  authorize.mockImplementationOnce(async () => {
    current = { ...scope, threadId: 'other' }
    return true
  })
  expect(await openNativeLogicalSource(input, 'source')).toBe('unavailable')
  connected = false
  expect(await openNativeLogicalSource(input, 'source')).toBe('unavailable')
  expect(navigate).toHaveBeenCalledOnce()
})
