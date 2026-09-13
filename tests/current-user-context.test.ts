import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { CurrentUserV1 } from '@cordisx/protocol/current-user/v1'
import type { PluginController } from '../packages/cli/src/renderer/runtime-shared.js'
import {
  disposePluginProfileSurfaces,
  installPluginProfileSurfaces,
} from '../packages/cli/src/renderer/plugin-profile-surfaces.js'
const nativeRead = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'available' as const, identity: 'native-private-test-id', displayName: 'GH L' }))
)
vi.mock('../packages/cli/src/renderer/current-user/native.js', () => ({ readNativeCurrentUser: nativeRead }))

test('installs on an isolated owner before plugin apply; public inject reads, subscribes and retires with its fiber', async () => {
  const dom = new JSDOM('', { url: 'https://test.example' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('localStorage', dom.window.localStorage)
  vi.stubGlobal('MutationObserver', dom.window.MutationObserver)
  const root = new Context()
  const owned = root.isolate('currentUser').isolate('isolatedGameUi').isolate('restrictedContent')
  const controller = { principalLive: true } as PluginController
  const options = {
    active: () => controller.principalLive,
    ownerKey: JSON.stringify(['test-owner-source', 'game-room']),
  }
  let api: CurrentUserV1 | undefined
  const callback = vi.fn()
  installPluginProfileSurfaces(owned, controller, dom.window.document, options)
  const fiber = owned.plugin({
    apply(context: Context) {
      context.inject(['currentUser'], child => {
        api = child.currentUser
        const unsubscribe = api.subscribe(callback)
        child.effect(() => () => unsubscribe())
      })
    },
  })
  try {
    await fiber
    expect(api?.contract).toBe('cordisx.current-user/v1')
    expect(await api?.read()).toMatchObject({ status: 'available', profile: { displayName: 'GH L' } })
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ status: 'available', profile: { displayName: 'GH L' } })
    let late: ((value: Awaited<ReturnType<typeof nativeRead>>) => void) | undefined
    nativeRead.mockImplementationOnce(() =>
      new Promise(resolve => {
        late = resolve
      })
    )
    const previous = api!.read()
    nativeRead.mockResolvedValueOnce({
      status: 'available',
      identity: 'native-private-test-id',
      displayName: 'Changed profile',
    })
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: { type: 'mcp-notification', message: { method: 'account/updated' } },
      }),
    )
    expect(await previous).toEqual({ status: 'unavailable', reason: 'host-unavailable' })
    await vi.waitFor(() =>
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'available',
          profile: expect.objectContaining({ displayName: 'Changed profile' }),
        }),
      )
    )
    late?.({ status: 'available', identity: 'retired-native-id', displayName: 'Retired account' })
    await Promise.resolve()
    expect(callback.mock.calls.some(call => call[0]?.profile?.displayName === 'Retired account')).toBe(false)
    expect(callback.mock.calls.some(call => call[0]?.status === 'unavailable')).toBe(true)
    await fiber.dispose()
    const callbacks = callback.mock.calls.length
    dom.window.dispatchEvent(new dom.window.Event('focus'))
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(callbacks)
    controller.principalLive = false
    expect(await api?.read()).toEqual({ status: 'unavailable', reason: 'generation-retired' })
  } finally {
    await fiber.dispose()
    await disposePluginProfileSurfaces(controller)
    vi.unstubAllGlobals()
    dom.window.close()
  }
})
