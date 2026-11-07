import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const { createManagedConsoleView } = createRequire(import.meta.url)(
  '../packages/cli/native/managed-console-view.cjs',
)

function nativeFixture() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    loadURL: vi.fn(async () => {}),
    close: vi.fn(),
    setWindowOpenHandler: vi.fn<(_open: () => { action: string }) => void>(),
  })
  const view = { webContents: contents, setVisible: vi.fn(), setBounds: vi.fn() }
  const partition = Object.assign(new EventEmitter(), {
    cookies: { set: vi.fn(async () => {}) },
    webRequest: {
      onBeforeRequest: vi.fn<
        (_fence: (request: { url: string }, decision: (result: { cancel: boolean }) => void) => void) => void
      >(),
      onCompleted: vi.fn(),
    },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    clearStorageData: vi.fn(async () => {}),
  })
  const electron = {
    session: { fromPartition: vi.fn(() => partition) },
    WebContentsView: vi.fn(function() {
      return view
    }),
  }
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { getZoomFactor: () => 1 },
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ width: 1000, height: 600 }),
  })
  const origin = 'http://127.0.0.1:12345'
  const input = {
    origin,
    url: origin + '/providers',
    cookie: {
      name: '__Host-managed_fixture',
      value: 's'.repeat(36),
      expirationDate: Date.now() / 1000 + 30,
    },
  }
  return { contents, view, partition, electron, window, origin, input }
}

describe('native managed console view', () => {
  it('installs credentials only in an ephemeral confined partition and retires the whole view', async () => {
    const { contents, view, partition, electron, window, origin, input } = nativeFixture()
    const handle = await createManagedConsoleView(electron, window, input)
    expect(electron.session.fromPartition).toHaveBeenCalledWith(
      expect.stringMatching(/^cordisx-managed-console-/),
      { cache: false },
    )
    expect(electron.WebContentsView).toHaveBeenCalledWith({
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
      },
    })
    expect(partition.cookies.set).toHaveBeenCalledWith({
      url: origin + '/',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      ...input.cookie,
    })
    expect(partition.webRequest.onBeforeRequest.mock.invocationCallOrder[0])
      .toBeLessThan(partition.cookies.set.mock.invocationCallOrder[0]!)
    expect(partition.cookies.set.mock.invocationCallOrder[0])
      .toBeLessThan(contents.loadURL.mock.invocationCallOrder[0]!)
    const fence = partition.webRequest.onBeforeRequest.mock.calls[0]?.[0]
    const decision = vi.fn()
    fence!({ url: origin + '/api/me' }, decision)
    expect(decision).toHaveBeenLastCalledWith({ cancel: false })
    for (const url of ['http://127.0.0.1:12346/api/me', 'https://elsewhere.invalid/', 'file:///etc/passwd']) {
      fence!({ url }, decision)
      expect(decision).toHaveBeenLastCalledWith({ cancel: true })
    }
    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: 'deny' })
    const bounds = { x: 200, y: 80, width: 800, height: 520 }
    handle.setBounds(bounds)
    expect(view.setBounds).toHaveBeenCalledWith(bounds)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    handle.setBounds({ ...bounds, width: 801 })
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    await handle.close()
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(contents.close).toHaveBeenCalledOnce()
    expect(partition.clearStorageData).toHaveBeenCalledOnce()
    fence!({ url: origin + '/api/me' }, decision)
    expect(decision).toHaveBeenLastCalledWith({ cancel: true })
  })

  it('clears a rejected credential without mounting or navigating', async () => {
    const { contents, partition, electron, window, input } = nativeFixture()
    partition.cookies.set.mockRejectedValueOnce(new Error('secret fixture'))
    await expect(createManagedConsoleView(electron, window, input)).rejects.toThrow(
      'Could not open isolated managed console',
    )
    expect(contents.loadURL).not.toHaveBeenCalled()
    expect(window.contentView.addChildView).not.toHaveBeenCalled()
    expect(partition.clearStorageData).toHaveBeenCalledOnce()
  })
})
