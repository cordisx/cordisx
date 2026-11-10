import vm from 'node:vm'
import { expect, it, vi } from 'vitest'
import {
  CdpConnectionClosedError,
  type CdpSession,
  CdpTargetClosedError,
} from '../packages/cli/src/launcher/cdp-session.js'
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

it.each(['before-cleanup', 'Runtime.evaluate', 'Runtime.removeBinding', 'Page.removeScriptToEvaluateOnNewDocument'])(
  'releases document cleanup after explicit target retirement at %s',
  async retirement => {
    let retired = retirement === 'before-cleanup'
    const send = vi.fn(async (method: string) => {
      if (method === retirement) {
        retired = true
        throw new CdpTargetClosedError()
      }
      return {}
    })
    const session = { send, isTargetClosed: () => retired } as unknown as CdpSession
    const cleanup = nativeSubmissionChannelCleanup('old', () => 'old-script', session)
    await expect(cleanup(session)).resolves.toBeUndefined()
    const methods = ['Runtime.evaluate', 'Runtime.removeBinding', 'Page.removeScriptToEvaluateOnNewDocument']
    expect(send.mock.calls.map(([method]) => method)).toEqual(
      retirement === 'before-cleanup' ? [] : methods.slice(0, methods.indexOf(retirement) + 1),
    )
    const replacementSend = vi.fn(async () => ({}))
    await cleanup({ send: replacementSend, isTargetClosed: () => false } as unknown as CdpSession)
    expect(replacementSend).not.toHaveBeenCalled()
  },
)

it.each([false, true])(
  'retains cleanup failures without retirement proof or of a different kind (%s)',
  async retired => {
    const error = retired ? new Error('cleanup permission denied') : new CdpConnectionClosedError('socket closed')
    const send = vi.fn(async () => {
      // A failure can race with retirement, but only the typed closed transport is removed by retirement.
      closedTarget = retired
      throw error
    })
    let closedTarget = false
    const session = { send, isTargetClosed: () => closedTarget } as unknown as CdpSession
    await expect(nativeSubmissionChannelCleanup('old', () => 'old-script')(session)).rejects.toBe(error)
  },
)
