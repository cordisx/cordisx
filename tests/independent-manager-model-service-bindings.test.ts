import { expect, it, vi } from 'vitest'
import { installIndependentHostBindings } from '../packages/cli/src/independent-manager/host-bindings.js'

it('allows refresh during a model-service read but not while a save is pending', async () => {
  const fetch = vi.fn((_path: string, options: RequestInit) =>
    new Promise<Response>((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  )
  const receive = vi.fn()
  const browser = { fetch, __cordisxModelServicesReceiveV1: receive } as unknown as Window
  const dispose = installIndependentHostBindings({
    window: browser,
    sessionToken: 'a'.repeat(64),
    channels: ['model-services'],
  })
  const binding = (browser as unknown as { __cordisxModelServicesRequestV1: (value: string) => void })
    .__cordisxModelServicesRequestV1
  try {
    binding(JSON.stringify({ requestId: 'read', operation: 'read' }))
    expect(dispose.canResume()).toBe(true)
    binding(JSON.stringify({ requestId: 'save', operation: 'save' }))
    // A queued write can still be canceled before it reaches the owner.
    expect(dispose.canResume()).toBe(true)
    await Promise.resolve()
    expect(dispose.canResume()).toBe(false)
    dispose()
    expect(receive).toHaveBeenCalledTimes(2)
    expect(JSON.parse(receive.mock.calls[1]![0])).toMatchObject({
      requestId: 'save',
      ok: false,
      code: 'INDEPENDENT_HOST_RESULT_UNKNOWN',
    })
  } finally {
    dispose()
  }
})

it('waits for owner admission before dispatching a model-service write', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => {
    admit = resolve
  })
  const fetch = vi.fn(async (_path: string, options: RequestInit) => {
    const envelope = JSON.parse(String(options.body)) as { payload: string }
    const payload = JSON.parse(envelope.payload) as { requestId: string }
    return new Response(JSON.stringify({ requestId: payload.requestId, ok: true }), { status: 200 })
  })
  const browser = { fetch, __cordisxModelServicesReceiveV1: vi.fn() } as unknown as Window
  const dispose = installIndependentHostBindings({
    window: browser,
    sessionToken: 'a'.repeat(64),
    channels: ['model-services'],
    rendererAdmission: admission,
  })
  const binding = (browser as unknown as { __cordisxModelServicesRequestV1: (value: string) => void })
    .__cordisxModelServicesRequestV1
  try {
    binding(JSON.stringify({ requestId: 'read', operation: 'read' }))
    binding(JSON.stringify({ requestId: 'save', operation: 'save' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(dispose.canResume()).toBe(true)
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  } finally {
    dispose()
  }
})

it('does not dispatch a queued write when the renderer closes before admission', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => {
    admit = resolve
  })
  const fetch = vi.fn()
  const receive = vi.fn()
  const browser = { fetch, __cordisxModelServicesReceiveV1: receive } as unknown as Window
  const dispose = installIndependentHostBindings({
    window: browser,
    sessionToken: 'a'.repeat(64),
    channels: ['model-services'],
    rendererAdmission: admission,
  })
  const binding = (browser as unknown as { __cordisxModelServicesRequestV1: (value: string) => void })
    .__cordisxModelServicesRequestV1
  binding(JSON.stringify({ requestId: 'save', operation: 'save' }))
  await Promise.resolve()
  dispose()
  admit(true)
  await Promise.resolve()
  expect(fetch).not.toHaveBeenCalled()
  expect(JSON.parse(receive.mock.calls[0]![0])).toMatchObject({ code: 'INDEPENDENT_HOST_SESSION_REVOKED' })
})

it('waits for admission for a Channel snapshot while keeping it safe to refresh', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => {
    admit = resolve
  })
  const fetch = vi.fn(async () => new Response(JSON.stringify({ requestId: 'snapshot', ok: true }), { status: 200 }))
  const browser = { fetch, __cordisxChannelActionsReceiveV1: vi.fn() } as unknown as Window
  const dispose = installIndependentHostBindings({
    window: browser,
    sessionToken: 'a'.repeat(64),
    channels: ['channel-actions'],
    rendererAdmission: admission,
  })
  const binding = (browser as unknown as { __cordisxChannelActionsRequestV1: (value: string) => void })
    .__cordisxChannelActionsRequestV1
  try {
    binding(JSON.stringify({ requestId: 'snapshot', action: 'snapshot' }))
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(dispose.canResume()).toBe(true)
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  } finally {
    dispose()
  }
})

it('allows refresh while renderer-owned startup observation requests are pending', async () => {
  const fetch = vi.fn((_path: string, options: RequestInit) =>
    new Promise<Response>((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  )
  const onSessionLost = vi.fn()
  const browser = { fetch, __cordisxManagedServiceUIReceiveV1: vi.fn() } as unknown as Window
  const dispose = installIndependentHostBindings({
    window: browser,
    sessionToken: 'a'.repeat(64),
    channels: ['managed-service-ui'],
    onSessionLost,
  })
  const binding = (browser as unknown as { __cordisxManagedServiceUIRequestV1: (value: string) => void })
    .__cordisxManagedServiceUIRequestV1
  try {
    for (const operation of ['startupRead', 'startupSubscribe', 'startupNext', 'startupClose']) {
      binding(JSON.stringify({ requestId: operation, operation }))
    }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    expect(dispose.canResume()).toBe(true)
    binding(JSON.stringify({ requestId: 'write', operation: 'authenticate' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5))
    expect(dispose.canResume()).toBe(false)
  } finally {
    dispose()
    expect(onSessionLost).not.toHaveBeenCalled()
  }
})
