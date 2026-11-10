import vm from 'node:vm'
import { expect, it, vi } from 'vitest'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import { nativeSubmissionChannelCleanup } from '../packages/cli/src/launcher/native-submission-channel-cleanup.js'

it('retries only failed removal and never disposes a newer channel owner', async () => {
  const dispose = vi.fn()
  const context = vm.createContext({
    __cordisxNativeProviderOwner: { rendererGeneration: 'old' },
    __cordisxNativeSubmissionChannelDispose: dispose,
  })
  let failRemove = true
  const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'Runtime.evaluate') {
      try {
        vm.runInContext(String(params.expression), context)
      } catch {
        return { exceptionDetails: {} }
      }
    }
    if (method === 'Page.removeScriptToEvaluateOnNewDocument' && failRemove) throw new Error('temporary disconnect')
    return {}
  })
  const session = { send } as unknown as CdpSession
  const cleanup = nativeSubmissionChannelCleanup('old', () => 'old-script')
  await expect(cleanup(session)).rejects.toThrow('temporary disconnect')
  expect(dispose).toHaveBeenCalledOnce()
  failRemove = false
  await cleanup(session)
  expect(dispose).toHaveBeenCalledOnce()
  expect(send.mock.calls.filter(([method]) => method === 'Runtime.removeBinding')).toHaveLength(1)
  expect(send.mock.calls.filter(([method]) => method === 'Page.removeScriptToEvaluateOnNewDocument')).toHaveLength(2)
  const newerCleanup = nativeSubmissionChannelCleanup('different-owner', () => 'other-script')
  const count = send.mock.calls.length
  await expect(newerCleanup(session)).rejects.toThrow('cleanup was rejected')
  expect(send.mock.calls.length).toBe(count + 1)
  expect(dispose).toHaveBeenCalledOnce()
})
