import { expect, it, vi } from 'vitest'
import { installIndependentHostBindings } from '../packages/cli/src/independent-manager/host-bindings.js'

type TestWindow = Window & Record<string, any>
const token = 'a'.repeat(64)

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
    expect(dispose.canResume()).toBe(false)
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
    expect(dispose.canResume()).toBe(false)
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
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
    expect(dispose.canResume()).toBe(false)
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    admit(true)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).channel).toBe('channel-credentials')
  } finally {
    dispose()
  }
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
