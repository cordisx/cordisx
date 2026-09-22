import { afterEach, describe, expect, it, vi } from 'vitest'
import { ViteLoopbackPermissionCoordinator } from '../packages/cli/src/launcher/cdp-installation-support.js'
import { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pending loopback permission restoration', () => {
  it('serializes concurrent acquisition so releasing one renderer cannot revoke another grant', async () => {
    let finishGrant!: (value: Record<string, unknown>) => void
    const granting = new Promise<Record<string, unknown>>(resolve => {
      finishGrant = resolve
    })
    const send = vi.fn().mockReturnValue(granting)
    const session = { send } as unknown as CdpSession
    const permissions = new ViteLoopbackPermissionCoordinator(1234)
    const target = { id: 'native', type: 'page', title: 'Codex', url: 'app://-/index.html' }
    const first = permissions.acquire(session, target)
    const second = permissions.acquire(session, { ...target, id: 'secondary' })
    finishGrant({})
    const leases = await Promise.all([first, second])
    await permissions.release(session, leases[0])
    expect(send).toHaveBeenCalledTimes(1)
    await permissions.release(session, leases[1])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('finishes an in-flight restore before granting access to a newly acquired renderer', async () => {
    let finishRestore!: (value: Record<string, unknown>) => void
    const restoring = new Promise<Record<string, unknown>>(resolve => {
      finishRestore = resolve
    })
    let restoreStarted!: () => void
    const started = new Promise<void>(resolve => {
      restoreStarted = resolve
    })
    const send = vi.fn().mockResolvedValueOnce({}).mockImplementationOnce(() => {
      restoreStarted()
      return restoring
    }).mockResolvedValue({})
    const session = { send } as unknown as CdpSession
    const permissions = new ViteLoopbackPermissionCoordinator(1234)
    const target = { id: 'native', type: 'page', title: 'Codex', url: 'app://-/index.html' }
    const first = await permissions.acquire(session, target)
    const release = permissions.release(session, first)
    await started
    const acquire = permissions.acquire(session, { ...target, id: 'secondary' })
    finishRestore({})
    const [, second] = await Promise.all([release, acquire])
    expect(send.mock.calls.map(call => call[1].setting)).toEqual(['granted', 'prompt', 'granted'])
    await permissions.release(session, first)
    expect(send).toHaveBeenCalledTimes(3)
    await permissions.release(session, second)
    expect(send).toHaveBeenCalledTimes(4)
  })

  it('does not let an old failed release consume a new renderer lease', async () => {
    const send = vi.fn().mockResolvedValue({})
    const session = { send } as unknown as CdpSession
    vi.spyOn(CdpSession, 'connect').mockRejectedValue(new Error('browser unavailable'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://fixture' }))))
    const permissions = new ViteLoopbackPermissionCoordinator(1234)
    const target = { id: 'native', type: 'page', title: 'Codex', url: 'app://-/index.html' }
    const first = await permissions.acquire(session, target)
    send.mockRejectedValueOnce(new Error('target closed'))
    await expect(permissions.release(session, first)).rejects.toThrow('could not restore')
    const second = await permissions.acquire(session, { ...target, id: 'secondary' })
    await permissions.release(session, first)
    expect(send).toHaveBeenCalledTimes(2)
    await permissions.release(session, second)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls[2]![1]).toMatchObject({ setting: 'prompt' })
  })

  it('keeps rejecting failed restoration on a closed target until a browser retry succeeds', async () => {
    const targetSend = vi.fn().mockResolvedValue({})
    const targetSession = { send: targetSend } as unknown as CdpSession
    const browserSend = vi.fn().mockRejectedValue(new Error('fixture permission restore denied'))
    const browserClose = vi.fn()
    vi.spyOn(CdpSession, 'connect').mockResolvedValue(
      { send: browserSend, close: browserClose } as unknown as CdpSession,
    )
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://fixture' }))))
    const permissions = new ViteLoopbackPermissionCoordinator(1234)
    const permission = await permissions.acquire(targetSession, {
      id: 'native',
      type: 'page',
      title: 'Codex',
      url: 'app://-/index.html',
    })
    targetSend.mockRejectedValue(new Error('CDP connection is closed'))
    await expect(permissions.release(targetSession, permission)).rejects.toThrow('could not restore')
    // A failed uninstall can be retried by the watcher. Zero references is still an outstanding grant.
    await expect(permissions.release(targetSession, permission)).rejects.toThrow('could not restore')
    expect(browserSend).toHaveBeenCalledTimes(2)
    expect(browserClose).toHaveBeenCalledTimes(2)

    browserSend.mockResolvedValue({})
    await expect(permissions.release(targetSession, permission)).resolves.toBeUndefined()
    expect(browserSend).toHaveBeenLastCalledWith('Browser.setPermission', {
      permission: { name: 'loopback-network' },
      setting: 'prompt',
      origin: 'app://-',
      embeddedOrigin: 'app://-',
    })
    await permissions.release(targetSession, permission)
    expect(browserSend).toHaveBeenCalledTimes(3)
  })

  it('retains shared grants until the final renderer releases them', async () => {
    const send = vi.fn().mockResolvedValue({})
    const session = { send } as unknown as CdpSession
    const permissions = new ViteLoopbackPermissionCoordinator(1234)
    const target = { id: 'native', type: 'page', title: 'Codex', url: 'app://-/index.html' }
    const first = await permissions.acquire(session, target)
    const second = await permissions.acquire(session, { ...target, id: 'secondary' })
    await permissions.release(session, first)
    expect(send).toHaveBeenCalledTimes(1)
    await permissions.release(session, second)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![1]).toMatchObject({ setting: 'prompt' })
  })
})
