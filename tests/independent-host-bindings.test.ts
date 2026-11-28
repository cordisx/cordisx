import { expect, it, vi } from 'vitest'
import { installIndependentHostBindings } from '../packages/cli/src/independent-manager/host-bindings.js'

type TestWindow = Window & Record<string, any>
const token = 'a'.repeat(64)

it('forwards model catalog calls during startup for an owner policy check', async () => {
  const admission = new Promise<boolean>(() => {})
  const receive = vi.fn()
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const request = JSON.parse(JSON.parse(String(options.body)).payload)
    return new Response(JSON.stringify({ requestId: request.requestId, ok: true, value: { ok: false } }))
  })
  const target = { fetch, __cordisxPlatformModelsReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['platform-models'],
    rendererAdmission: admission,
  })
  try {
    target.__cordisxPlatformModelsRequestV1(JSON.stringify({ requestId: 'startup-models' }))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledOnce()
  } finally {
    dispose()
  }
})

it('loads documents before admission but waits to write, and rejects oversized writes before dispatch', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => admit = resolve)
  const receive = vi.fn()
  const lost = vi.fn()
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body))
    const request = JSON.parse(body.payload)
    return new Response(JSON.stringify({ requestId: request.requestId, ok: true, value: 'available' }))
  })
  const target = { fetch, __cordisxOwnerDocumentReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['owner-document'],
    rendererAdmission: admission,
    onSessionLost: lost,
  })
  try {
    target.__cordisxOwnerDocumentRequestV1(JSON.stringify({ requestId: 'read', operation: 'load' }))
    target.__cordisxOwnerDocumentRequestV1(JSON.stringify({ requestId: 'write', operation: 'replace' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(JSON.parse(JSON.parse(String(fetch.mock.calls[0]![1].body)).payload).operation).toBe('load')
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(() =>
      target.__cordisxOwnerDocumentRequestV1(JSON.stringify({
        requestId: 'large',
        operation: 'replace',
        value: '"'.repeat(70_000),
      }))
    ).toThrow('independent-host-request-too-large')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(lost).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

it.each([
  new Response(JSON.stringify({ error: 'RENDERER_BINDING_UNAVAILABLE' }), { status: 503 }),
  new Response(JSON.stringify({
    requestId: 'read',
    ok: true,
    value: {
      status: 'unavailable',
      code: 'host-unavailable',
      diagnostic: 'owner document request was rejected',
      recoverable: true,
    },
  })),
])('retries a temporarily unavailable document read without replaying a write', async unavailable => {
  const receive = vi.fn()
  const lost = vi.fn()
  const fetch = vi.fn()
    .mockResolvedValueOnce(unavailable)
    .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: 'read', ok: true, value: { status: 'missing' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'RENDERER_BINDING_UNAVAILABLE' }), { status: 503 }))
  const target = { fetch, __cordisxOwnerDocumentReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['owner-document'],
    rendererAdmission: Promise.resolve(true),
    onSessionLost: lost,
  })
  try {
    target.__cordisxOwnerDocumentRequestV1(JSON.stringify({ requestId: 'read', operation: 'load' }))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(receive.mock.calls[0]![0]).value.status).toBe('missing')
    target.__cordisxOwnerDocumentRequestV1(JSON.stringify({ requestId: 'write', operation: 'replace' }))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(JSON.parse(receive.mock.calls[1]![0]).code).toBe('INDEPENDENT_HOST_RESULT_UNKNOWN')
    expect(lost).toHaveBeenCalledOnce()
  } finally {
    dispose()
  }
})

it('uses the transport id for a managed-service action with a separate domain id', async () => {
  const receive = vi.fn()
  const fetch = vi.fn(async () =>
    new Response(JSON.stringify({ requestId: 'transport-id', ok: true, value: { status: 'accepted' } }))
  )
  const target = { fetch, __cordisxManagedServiceUIReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['managed-service-ui'],
    rendererAdmission: Promise.resolve(true),
  })
  try {
    target.__cordisxManagedServiceUIRequestV1(JSON.stringify({
      requestId: 'transport-id',
      operation: 'authenticate',
      request: { requestId: 'action-id' },
    }))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(JSON.parse(receive.mock.calls[0]![0])).toMatchObject({ requestId: 'transport-id', ok: true })
    expect(fetch).toHaveBeenCalledOnce()
  } finally {
    dispose()
  }
})

it('keeps the renderer available when an account read is temporarily rejected', async () => {
  const receive = vi.fn()
  const lost = vi.fn()
  const fetch = vi.fn(async () => new Response('', { status: 503 }))
  const target = { fetch, __cordisxManagedServiceUIReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['managed-service-ui'],
    rendererAdmission: Promise.resolve(true),
    onSessionLost: lost,
  })
  try {
    target.__cordisxManagedServiceUIRequestV1(JSON.stringify({ requestId: 'account-read', operation: 'readAccounts' }))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(lost).not.toHaveBeenCalled()
    expect(dispose.canResume()).toBe(true)
    expect(target.__cordisxManagedServiceUIRequestV1).toBeTypeOf('function')
  } finally {
    dispose()
  }
})

it('waits for renderer admission before reading managed accounts', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => admit = resolve)
  const receive = vi.fn()
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body))
    const request = JSON.parse(body.payload)
    return new Response(JSON.stringify({ requestId: request.requestId, ok: true, value: 'available' }))
  })
  const target = { fetch, __cordisxManagedServiceUIReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['managed-service-ui'],
    rendererAdmission: admission,
  })
  try {
    target.__cordisxManagedServiceUIRequestV1(JSON.stringify({ requestId: 'accounts', operation: 'readAccounts' }))
    target.__cordisxManagedServiceUIRequestV1(JSON.stringify({ requestId: 'snapshot', operation: 'snapshot' }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(JSON.parse(JSON.parse(String(fetch.mock.calls[0]![1].body)).payload).operation).toBe('snapshot')
    expect(dispose.canResume()).toBe(true)
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(JSON.parse(String(fetch.mock.calls[1]![1].body)).payload).operation).toBe('readAccounts')
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2))
  } finally {
    dispose()
  }
})

it('waits for admission before a catalog read and keeps navigation recoverable', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => admit = resolve)
  const fetch = vi.fn(() => new Promise(() => {}))
  const target = { fetch, __cordisxNativeCatalogReceiveV1: vi.fn() } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['native-catalog'],
    rendererAdmission: admission,
  })
  try {
    target.__cordisxNativeCatalogRequestV1(JSON.stringify({ version: 1, requestId: 'catalog', operation: 'read' }))
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(dispose.canResume()).toBe(true)
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(dispose.canResume()).toBe(true)
  } finally {
    dispose()
  }
})

it('does not dispatch a queued account read after admission is denied', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => admit = resolve)
  const receive = vi.fn()
  const fetch = vi.fn()
  const target = { fetch, __cordisxManagedServiceUIReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['managed-service-ui'],
    rendererAdmission: admission,
  })
  try {
    target.__cordisxManagedServiceUIRequestV1(JSON.stringify({ requestId: 'accounts', operation: 'readAccounts' }))
    admit(false)
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.parse(receive.mock.calls[0]![0])).toMatchObject({ ok: false })
  } finally {
    dispose()
  }
})

it.each(['snapshot', 'readCatalog', 'readAccounts'] as const)(
  'retries a temporarily busy managed-service %s read without losing the session',
  async operation => {
    const receive = vi.fn()
    const lost = vi.fn()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'RENDERER_BINDING_UNAVAILABLE' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: 'read-1', ok: true, value: 'available' })))
    const target = { fetch, __cordisxManagedServiceUIReceiveV1: receive } as unknown as TestWindow
    const dispose = installIndependentHostBindings({
      window: target,
      sessionToken: token,
      channels: ['managed-service-ui'],
      onSessionLost: lost,
    })
    try {
      target.__cordisxManagedServiceUIRequestV1(JSON.stringify({ requestId: 'read-1', operation }))
      await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
      expect(JSON.parse(receive.mock.calls[0]![0])).toEqual({ requestId: 'read-1', ok: true, value: 'available' })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body)
      expect(lost).not.toHaveBeenCalled()
      expect(dispose.canResume()).toBe(true)
    } finally {
      dispose()
    }
  },
)

it('reuses one observation request while the sidecar yields browser connections', async () => {
  const receive = vi.fn()
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), { status: 202 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), { status: 202 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ requestId: 'watch', ok: true, value: 'event' }), { status: 200 }),
    )
  const target = { fetch, __cordisxManagedServiceUIReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['managed-service-ui'],
  })
  try {
    target.__cordisxManagedServiceUIRequestV1(JSON.stringify({ requestId: 'watch', operation: 'next' }))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(new Set(fetch.mock.calls.map(([, options]) => options.body)).size).toBe(1)
    expect(JSON.parse(receive.mock.calls[0]![0])).toEqual({ requestId: 'watch', ok: true, value: 'event' })
    expect(dispose.canResume()).toBe(true)
  } finally {
    dispose()
  }
})

it('retries a permission decision only after an explicit pre-dispatch rejection', async () => {
  const receive = vi.fn()
  const lost = vi.fn()
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'PERMISSION_WRITE_NOT_DISPATCHED' }), { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: 'policy', ok: true, value: [] })))
  const target = { fetch, __cordisxPermissionPolicyReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['permission-policy'],
    onSessionLost: lost,
  })
  try {
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'policy', proof: 'one-use' }))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body)
    expect(JSON.parse(receive.mock.calls[0]![0])).toEqual({ requestId: 'policy', ok: true, value: [] })
    expect(lost).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

it('does not replay a permission decision when the result may be unknown', async () => {
  const receive = vi.fn()
  const lost = vi.fn()
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'OPERATION_RESULT_UNKNOWN' }), { status: 503 }))
  const target = { fetch, __cordisxPermissionPolicyReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['permission-policy'],
    onSessionLost: lost,
  })
  try {
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'policy', proof: 'one-use' }))
    await vi.waitFor(() => expect(lost).toHaveBeenCalledExactlyOnceWith('result-unknown'))
    expect(fetch).toHaveBeenCalledOnce()
  } finally {
    dispose()
  }
})

it('stops an observation retry when the renderer closes', async () => {
  const receive = vi.fn()
  const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 }))
  const target = { fetch, __cordisxManagedServiceUIReceiveV1: receive } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['managed-service-ui'],
  })
  target.__cordisxManagedServiceUIRequestV1(JSON.stringify({ requestId: 'watch', operation: 'closed' }))
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  dispose()
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(fetch).toHaveBeenCalledOnce()
  expect(receive).toHaveBeenCalledOnce()
})

it('forwards only owner-granted bindings with a session header and correlates existing response envelopes', async () => {
  const receiveConfig = vi.fn()
  const receiveLifecycle = vi.fn()
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body))
    const payload = JSON.parse(body.payload)
    const requestId = payload.requestId ?? payload.request?.requestId
    return { ok: true, status: 200, text: async () => JSON.stringify({ requestId, ok: true, value: body.channel }) }
  })
  const target = {
    fetch,
    __cordisxConfigReceiveV1: receiveConfig,
    __cordisxPluginLifecycleReceiveV1: receiveLifecycle,
  } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['config', 'plugin-lifecycle'],
  })
  try {
    expect(dispose.canResume()).toBe(true)
    expect(target.__cordisxProviderRequestV1).toBeUndefined()
    target.__cordisxConfigRequestV1(JSON.stringify({ requestId: 'config-1', operation: 'read' }))
    target.__cordisxPluginLifecycleRequestV1(JSON.stringify({ request: { requestId: 'lifecycle-1' } }))
    expect(dispose.canResume()).toBe(true)
    await vi.waitFor(() => expect(receiveLifecycle).toHaveBeenCalledOnce())
    expect(dispose.canResume()).toBe(true)
    expect(JSON.parse(receiveConfig.mock.calls[0]![0])).toEqual({ requestId: 'config-1', ok: true, value: 'config' })
    expect(JSON.parse(receiveLifecycle.mock.calls[0]![0])).toEqual({
      requestId: 'lifecycle-1',
      ok: true,
      value: 'plugin-lifecycle',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe('/api/renderer/binding')
      expect(options.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
      expect(options.body).not.toContain(token)
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    }
  } finally {
    dispose()
  }
  expect(target.__cordisxConfigRequestV1).toBeUndefined()
  expect(dispose.canResume()).toBe(false)
})

it('fences stale callbacks and reports a revoked session without retrying pending requests', async () => {
  let resolveFetch!: (response: { ok: boolean; status: number; text(): Promise<string> }) => void
  const fetch = vi.fn(() =>
    new Promise<{ ok: boolean; status: number; text(): Promise<string> }>(resolve => resolveFetch = resolve)
  )
  const readReply = vi.fn(async () => JSON.stringify({ requestId: 'one', ok: true }))
  const original = vi.fn()
  const replacement = vi.fn()
  const lost = vi.fn()
  const target = { fetch, __cordisxConfigReceiveV1: original } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['config'],
    onSessionLost: lost,
  })
  target.__cordisxConfigRequestV1(JSON.stringify({ requestId: 'one' }))
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  target.__cordisxConfigReceiveV1 = replacement
  resolveFetch({ ok: true, status: 200, text: readReply })
  await vi.waitFor(() => expect(readReply).toHaveBeenCalledOnce())
  await Promise.resolve()
  dispose()
  expect(original).not.toHaveBeenCalled()
  expect(replacement).not.toHaveBeenCalled()
  expect(lost).not.toHaveBeenCalled()
})

it('permits refresh with an owner-declared read pending but not with a write pending', async () => {
  const target = {
    fetch: vi.fn(() => new Promise(() => {})),
    __cordisxPluginManagementReceiveV1: vi.fn(),
  } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['plugin-management'],
  })
  try {
    target.__cordisxPluginManagementRequestV1(JSON.stringify({ requestId: 'read', operation: { kind: 'query' } }))
    expect(dispose.canResume()).toBe(true)
    target.__cordisxPluginManagementRequestV1(JSON.stringify({ requestId: 'write', operation: { kind: 'execute' } }))
    expect(dispose.canResume()).toBe(true)
    await vi.waitFor(() => expect(target.fetch).toHaveBeenCalledTimes(2))
    expect(dispose.canResume()).toBe(false)
  } finally {
    dispose()
  }
})

it('allows an owner-confirmed resume attempt after a lost startup migration response', async () => {
  const target = {
    fetch: vi.fn(() => new Promise(() => {})),
    __cordisxPluginManagementReceiveV1: vi.fn(),
  } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['plugin-management'],
    rendererAdmission: Promise.resolve(true),
  })
  try {
    target.__cordisxPluginManagementRequestV1(JSON.stringify({
      requestId: 'migration',
      operation: { kind: 'migrate-legacy-sources', input: { sources: [] } },
    }))
    await vi.waitFor(() => expect(target.fetch).toHaveBeenCalledOnce())
    expect(dispose.canResume()).toBe(true)
    expect(dispose.canQuiesce()).toBe(true)
    target.__cordisxPluginManagementRequestV1(JSON.stringify({ requestId: 'write', operation: { kind: 'execute' } }))
    await vi.waitFor(() => expect(target.fetch).toHaveBeenCalledTimes(2))
    expect(dispose.canResume()).toBe(false)
  } finally {
    dispose()
  }
})

it('allows an owner-confirmed resume attempt after a permission response is lost during navigation', async () => {
  let reject!: (error: Error) => void
  const lost = vi.fn()
  const receive = vi.fn()
  const target = {
    fetch: vi.fn(() => new Promise((_resolve, fail) => reject = fail)),
    __cordisxPermissionPolicyReceiveV1: receive,
  } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['permission-policy'],
    rendererAdmission: Promise.resolve(true),
    isNavigating: () => true,
    onSessionLost: lost,
  })
  try {
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'policy' }))
    await vi.waitFor(() => expect(target.fetch).toHaveBeenCalledOnce())
    expect(dispose.canResume()).toBe(true)
    expect(dispose.canQuiesce()).toBe(false)
    reject(new Error('response interrupted'))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(lost).not.toHaveBeenCalled()
    expect(dispose.hasUncertainWrite()).toBe(true)
    expect(dispose.canResume()).toBe(true)
    expect(dispose.canQuiesce()).toBe(false)
    expect(target.fetch).toHaveBeenCalledOnce()
  } finally {
    dispose()
  }
})

it('still isolates an uncertain permission write outside navigation', async () => {
  const lost = vi.fn()
  const target = {
    fetch: vi.fn(async () => new Response('{}', { status: 503 })),
    __cordisxPermissionPolicyReceiveV1: vi.fn(),
  } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['permission-policy'],
    rendererAdmission: Promise.resolve(true),
    isNavigating: () => false,
    onSessionLost: lost,
  })
  try {
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'policy' }))
    await vi.waitFor(() => expect(lost).toHaveBeenCalledExactlyOnceWith('result-unknown'))
    expect(dispose.canResume()).toBe(false)
  } finally {
    dispose()
  }
})

it('still reports an uncertain migration failure when no navigation is in progress', async () => {
  const lost = vi.fn()
  const target = {
    fetch: vi.fn(async () => new Response('{}', { status: 503 })),
    __cordisxPluginManagementReceiveV1: vi.fn(),
  } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['plugin-management'],
    rendererAdmission: Promise.resolve(true),
    isNavigating: () => false,
    onSessionLost: lost,
  })
  try {
    target.__cordisxPluginManagementRequestV1(JSON.stringify({
      requestId: 'migration',
      operation: { kind: 'migrate-legacy-sources', input: { sources: [] } },
    }))
    await vi.waitFor(() => expect(lost).toHaveBeenCalledExactlyOnceWith('result-unknown'))
    expect(dispose.canResume()).toBe(false)
  } finally {
    dispose()
  }
})

it('waits for admission and preserves refresh only for Channel configuration reads', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => admit = resolve)
  const fetch = vi.fn(() => new Promise(() => {}))
  const target = { fetch, __cordisxServiceConfigReceiveV1: vi.fn() } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['service-config'],
    rendererAdmission: admission,
  })
  try {
    target.__cordisxServiceConfigRequestV1(JSON.stringify({ requestId: 'read', operation: 'list' }))
    expect(dispose.canResume()).toBe(true)
    target.__cordisxServiceConfigRequestV1(JSON.stringify({ requestId: 'write', operation: 'mutate' }))
    expect(dispose.canResume()).toBe(true)
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(dispose.canResume()).toBe(false)
  } finally {
    dispose()
  }
})

it('admits the private credential channel before dispatch and blocks refresh while it is pending', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => admit = resolve)
  const fetch = vi.fn(() => new Promise(() => {}))
  const target = { fetch, __cordisxChannelCredentialReceiveV1: vi.fn() } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['channel-credentials'],
    rendererAdmission: admission,
  })
  try {
    target.__cordisxChannelCredentialRequestV1(JSON.stringify({ requestId: 'capture', operation: 'capture' }))
    expect(dispose.canResume()).toBe(true)
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(dispose.canResume()).toBe(false)
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).channel).toBe('channel-credentials')
  } finally {
    dispose()
  }
})

it('does not dispatch a permission write before the owner admits the renderer', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => admit = resolve)
  const fetch = vi.fn(() => new Promise(() => {}))
  const target = { fetch, __cordisxPermissionPolicyReceiveV1: vi.fn() } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['permission-policy'],
    rendererAdmission: admission,
  })
  try {
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'policy', records: [] }))
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(dispose.canResume()).toBe(true)
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(dispose.canResume()).toBe(true)
    expect(dispose.canQuiesce()).toBe(false)
  } finally {
    dispose()
  }
})

it('cancels a queued write before retaining refresh and never dispatches it later', async () => {
  let admit!: (value: boolean) => void
  const admission = new Promise<boolean>(resolve => admit = resolve)
  const fetch = vi.fn()
  const receiver = vi.fn()
  const target = { fetch, __cordisxServiceConfigReceiveV1: receiver } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['service-config'],
    rendererAdmission: admission,
  })
  target.__cordisxServiceConfigRequestV1(JSON.stringify({ requestId: 'queued', operation: 'mutate' }))
  await Promise.resolve()
  expect(dispose.canResume()).toBe(true)
  dispose()
  admit(true)
  await Promise.resolve()
  await Promise.resolve()
  expect(fetch).not.toHaveBeenCalled()
  expect(JSON.parse(receiver.mock.calls[0]![0])).toMatchObject({ code: 'INDEPENDENT_HOST_SESSION_REVOKED' })
})

it('retires the browser binding and reports an unknown result after a failed credential write', async () => {
  const receiver = vi.fn(), lost = vi.fn()
  const fetch = vi.fn(async () => ({ ok: false, status: 503, text: async () => '' }))
  const target = { fetch, __cordisxChannelCredentialReceiveV1: receiver } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['channel-credentials'],
    onSessionLost: lost,
  })
  try {
    target.__cordisxChannelCredentialRequestV1(JSON.stringify({ requestId: 'commit', operation: 'commit' }))
    await vi.waitFor(() => expect(lost).toHaveBeenCalledExactlyOnceWith('result-unknown'))
    expect(JSON.parse(receiver.mock.calls[0]![0])).toMatchObject({
      requestId: 'commit',
      ok: false,
      code: 'INDEPENDENT_HOST_RESULT_UNKNOWN',
    })
    expect(target.__cordisxChannelCredentialRequestV1).toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  } finally {
    dispose()
  }
})

it('rejects forged responses and does not retry an operation whose outcome is unknown', async () => {
  const receiver = vi.fn()
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ requestId: 'different', ok: true, value: 'wrong request' }),
  }))
  const target = { fetch, __cordisxConfigReceiveV1: receiver } as unknown as TestWindow
  const dispose = installIndependentHostBindings({ window: target, sessionToken: token, channels: ['config'] })
  try {
    target.__cordisxConfigRequestV1(JSON.stringify({ requestId: 'expected', operation: 'commit' }))
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce())
    expect(JSON.parse(receiver.mock.calls[0]![0])).toMatchObject({
      requestId: 'expected',
      ok: false,
      error: 'INDEPENDENT_HOST_RESULT_UNKNOWN',
    })
    expect(fetch).toHaveBeenCalledOnce()
  } finally {
    dispose()
  }
})

it('reports a revoked session when closed before dispatch and never sends the request', async () => {
  const receiver = vi.fn()
  const fetch = vi.fn()
  const target = { fetch, __cordisxConfigReceiveV1: receiver } as unknown as TestWindow
  const dispose = installIndependentHostBindings({ window: target, sessionToken: token, channels: ['config'] })
  target.__cordisxConfigRequestV1(JSON.stringify({ requestId: 'not-dispatched', operation: 'commit' }))
  dispose()
  await Promise.resolve()
  expect(fetch).not.toHaveBeenCalled()
  expect(JSON.parse(receiver.mock.calls[0]![0])).toMatchObject({
    requestId: 'not-dispatched',
    ok: false,
    error: 'INDEPENDENT_HOST_SESSION_REVOKED',
  })
})

it('retires all in-flight requests when the sidecar rejects the browser session', async () => {
  let rejectSession!: (response: { ok: boolean; status: number; text(): Promise<string> }) => void
  const fetch = vi.fn(() =>
    new Promise<{ ok: boolean; status: number; text(): Promise<string> }>(resolve => rejectSession = resolve)
  )
  const receiver = vi.fn()
  const lost = vi.fn()
  const target = { fetch, __cordisxConfigReceiveV1: receiver } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['config'],
    onSessionLost: lost,
  })
  target.__cordisxConfigRequestV1(JSON.stringify({ requestId: 'one' }))
  target.__cordisxConfigRequestV1(JSON.stringify({ requestId: 'two' }))
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  rejectSession({ ok: false, status: 401, text: async () => '' })
  await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce())
  expect(receiver.mock.calls.map(call => JSON.parse(call[0]).error)).toEqual([
    'INDEPENDENT_HOST_RESULT_UNKNOWN',
    'INDEPENDENT_HOST_RESULT_UNKNOWN',
  ])
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(target.__cordisxConfigRequestV1).toBeUndefined()
  dispose()
})

it('rejects conflicting request IDs before dispatch', () => {
  const fetch = vi.fn()
  const target = { fetch, __cordisxPluginLifecycleReceiveV1: vi.fn() } as unknown as TestWindow
  const dispose = installIndependentHostBindings({
    window: target,
    sessionToken: token,
    channels: ['plugin-lifecycle'],
  })
  try {
    expect(() =>
      target.__cordisxPluginLifecycleRequestV1(JSON.stringify({ requestId: 'one', request: { requestId: 'two' } }))
    )
      .toThrow('independent-host-request-invalid')
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

it('enforces the web server byte limit before dispatch, including JSON escaping', () => {
  const fetch = vi.fn()
  const target = { fetch, __cordisxConfigReceiveV1: vi.fn() } as unknown as TestWindow
  const dispose = installIndependentHostBindings({ window: target, sessionToken: token, channels: ['config'] })
  try {
    expect(() => target.__cordisxConfigRequestV1(JSON.stringify({ requestId: 'large', value: '\\'.repeat(400_000) })))
      .toThrow('independent-host-request-too-large')
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

it('refuses unknown channels and refuses to replace an existing binding', () => {
  const target = { fetch: vi.fn(), __cordisxConfigRequestV1: vi.fn() } as unknown as TestWindow
  expect(() => installIndependentHostBindings({ window: target, sessionToken: token, channels: ['unknown' as never] }))
    .toThrow('independent-host-channels-invalid')
  expect(() => installIndependentHostBindings({ window: target, sessionToken: token, channels: ['config'] }))
    .toThrow('independent-host-binding-already-installed')
})
