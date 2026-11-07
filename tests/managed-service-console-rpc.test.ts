import { describe, expect, it, vi } from 'vitest'
import { ManagedServiceConsoleRPC } from '../packages/cli/src/launcher/managed-service-console-rpc.js'
import type { ManagedConsolePreparation } from '../packages/cli/src/launcher/managed-service-console-broker.js'

const request = { viewId: 'view-1', serviceGeneration: 'generation-1' } as const

function fixture() {
  const revoke = vi.fn(async () => {})
  const close = vi.fn()
  const setBounds = vi.fn()
  let closed!: () => void
  const native = {
    close,
    setBounds,
    closed: new Promise<void>(resolve => {
      closed = resolve
    }),
  }
  const open = vi.fn(async () => native)
  const prepare = vi.fn<() => Promise<ManagedConsolePreparation>>(async () => ({
    status: 'prepared',
    origin: 'http://127.0.0.1:12345',
    url: 'http://127.0.0.1:12345/providers',
    cookie: { name: '__Host-fixture', value: 'private-cookie', expirationDate: Date.now() / 1000 + 30 },
    lifetime: new AbortController().signal,
    revoke,
  }))
  const reader = {
    serviceGeneration: request.serviceGeneration,
    timeoutMs: 100,
    read: async () => ({ status: 'available', origin: 'http://127.0.0.1:12345' } as const),
    authenticatedConsole: { prepare },
  }
  const adapter = { open, dispose: async () => {} }
  return { adapter, reader, open, prepare, revoke, close, setBounds, closed }
}

describe('managed console view broker RPC', () => {
  it('never prepares credentials if the adapter is unavailable or the service generation changed', async () => {
    const { adapter, reader, prepare } = fixture()
    const unavailable = new ManagedServiceConsoleRPC(() => undefined)
    await expect(unavailable.handle('owner', reader, { ...request, action: 'mount' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'unsupported' })
    const active = new ManagedServiceConsoleRPC(() => adapter)
    await expect(active.handle('owner', reader, { ...request, action: 'mount', serviceGeneration: 'old' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'stale-generation' })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('passes the cookie only to the private adapter and revokes on native sign-out or closure', async () => {
    const { adapter, reader, open, revoke, setBounds, closed } = fixture()
    const broker = new ManagedServiceConsoleRPC(() => adapter)
    await expect(broker.handle('owner', reader, { ...request, action: 'mount' })).resolves.toEqual({
      status: 'mounted',
    })
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ cookie: expect.objectContaining({ value: 'private-cookie' }) }),
      expect.any(AbortSignal),
    )
    const bounds = { x: 0, y: 0, width: 400, height: 300 }
    await expect(broker.handle('another-owner', reader, { ...request, action: 'update', bounds }))
      .resolves.toEqual({ status: 'closed' })
    expect(setBounds).not.toHaveBeenCalled()
    await expect(broker.handle('owner', reader, { ...request, action: 'update', bounds }))
      .resolves.toEqual({ status: 'active' })
    expect(setBounds).toHaveBeenCalledWith(bounds)
    closed()
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce())
    await expect(broker.handle('owner', reader, { ...request, action: 'update', bounds }))
      .resolves.toEqual({ status: 'closed' })
  })

  it('revokes a late credential when the owner is retired during preparation', async () => {
    const { adapter, reader, open, prepare, revoke } = fixture()
    const prepared = await prepare()
    let finish!: (value: ManagedConsolePreparation) => void
    prepare.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      }),
    )
    const broker = new ManagedServiceConsoleRPC(() => adapter)
    const mount = broker.handle('owner', reader, { ...request, action: 'mount' })
    await broker.disposeOwner('owner')
    finish(prepared)
    await expect(mount).resolves.toEqual({ status: 'unavailable', reason: 'cancelled' })
    expect(open).not.toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledOnce()
  })
})
