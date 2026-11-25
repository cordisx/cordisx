import { afterEach, expect, it, vi } from 'vitest'
import {
  activation,
  commandId,
  deferred,
  entryToken,
  fixture,
  origin,
  rendererId,
  sessionToken,
} from './fixtures/standalone-manager-client.js'

afterEach(() => {
  vi.useRealTimers()
})

it('reports an uncertain credential write when the Manager session is lost', async () => {
  const test = fixture({ credentialFailure: true })
  try {
    expect(await test.manager.ready).toBe(true)
    const target = test.win as unknown as Record<string, any>
    target.__cordisxChannelCredentialReceiveV1 = vi.fn()
    target.__cordisxChannelCredentialRequestV1(JSON.stringify({ requestId: 'commit', operation: 'commit' }))
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('result-unknown'))
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('keeps a slow owner bootstrap alive while it builds the initial bundle', async () => {
  vi.useFakeTimers()
  const gate = deferred<void>()
  const test = fixture({ bootstrapGate: gate.promise })
  try {
    await vi.advanceTimersByTimeAsync(0)
    const request = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/bootstrap')
    expect(request).toBeDefined()
    await vi.advanceTimersByTimeAsync(21_000)
    expect(request![1].signal!.aborted).toBe(false)
    expect(test.unavailable).not.toHaveBeenCalled()
    gate.resolve()
    expect(await test.manager.ready).toBe(true)
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('recovers a refreshed tab only after the old renderer is confirmed retired', async () => {
  const test = fixture({ resume: true })
  try {
    expect(await test.manager.ready).toBe(true)
    const requests = test.fetch.mock.calls.filter(call => call[0].startsWith('/api/session/resume/'))
    expect(requests).toHaveLength(2)
    expect(requests.every(([, options]) => options.credentials === 'same-origin')).toBe(true)
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/session')).toBe(false)
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    const open = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/open')!
    expect(open[1].credentials).toBe('same-origin')
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('keeps the same tab recovery attempt when refresh interrupts its exchange', async () => {
  const gate = deferred<void>()
  const test = fixture({ resume: true, resumeGate: gate.promise })
  try {
    await vi.waitFor(() =>
      expect(test.fetch.mock.calls.some(call => call[0].startsWith('/api/session/resume/'))).toBe(true)
    )
    const request = test.fetch.mock.calls.find(call => call[0].startsWith('/api/session/resume/'))!
    const body = JSON.parse(String(request[1].body)) as { attempt: string }
    expect(body.attempt).toMatch(/^[a-f0-9]{64}$/u)
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('e'.repeat(64))
    test.beforeUnload()
    test.pageHide()
    expect(await test.manager.ready).toBe(false)
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('e'.repeat(64))
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-attempt')).toContain(body.attempt)
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retains recovery after a lost response so the tab can retry', async () => {
  const test = fixture({ resume: true, loseResumeResponse: true })
  try {
    expect(await test.manager.ready).toBe(false)
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.fetch.mock.calls.filter(call => call[0].startsWith('/api/session/resume/'))).toHaveLength(2)
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('e'.repeat(64))
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-attempt')).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/u)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retries one interrupted recovery exchange with the same tab attempt', async () => {
  const test = fixture({ resume: true, resumeTransportFailures: 1 })
  try {
    expect(await test.manager.ready).toBe(true)
    const requests = test.fetch.mock.calls.filter(call => call[0].startsWith('/api/session/resume/'))
    expect(requests).toHaveLength(3)
    const attempts = requests.map(([, options]) => (JSON.parse(String(options.body)) as { attempt: string }).attempt)
    expect(attempts[0]).toMatch(/^[a-f0-9]{64}$/u)
    expect(new Set(attempts).size).toBe(1)
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('waits for the original recovery exchange when its retirement is still pending', async () => {
  vi.useFakeTimers()
  const test = fixture({ resume: true, resumeTransportFailures: 1, resumePendingResponses: 64 })
  try {
    await vi.advanceTimersByTimeAsync(17_000)
    expect(await test.manager.ready).toBe(true)
    const requests = test.fetch.mock.calls.filter(call => call[0].startsWith('/api/session/resume/'))
    const attempts = requests.map(([, options]) => (JSON.parse(String(options.body)) as { attempt: string }).attempt)
    expect(new Set(attempts).size).toBe(1)
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('stops waiting when recovery remains pending beyond the bounded window', async () => {
  vi.useFakeTimers()
  const test = fixture({ resume: true, resumePendingResponses: 100 })
  try {
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await test.manager.ready).toBe(false)
    expect(test.fetch.mock.calls.filter(call => call[0].startsWith('/api/session/resume/'))).toHaveLength(80)
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('e'.repeat(64))
    expect(test.unavailable).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('bounds recovery even if pending replies are slow', async () => {
  vi.useFakeTimers()
  const test = fixture({ resume: true, resumePendingResponses: 100, resumePendingDelay: 19_000 })
  try {
    await vi.advanceTimersByTimeAsync(45_100)
    expect(await test.manager.ready).toBe(false)
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('e'.repeat(64))
    expect(test.unavailable).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not retry an explicit recovery denial or a legacy exchange without an attempt', async () => {
  for (
    const options of [
      { resume: true, resumeUnauthorized: true },
      { resume: true, resumeTransportFailures: 1, resumeAttemptUnavailable: true },
    ]
  ) {
    const test = fixture(options)
    try {
      expect(await test.manager.ready).toBe(false)
      expect(test.fetch.mock.calls.filter(call => call[0].startsWith('/api/session/resume/'))).toHaveLength(1)
    } finally {
      await test.manager.close()
      test.dom.window.close()
    }
  }
})

it('retains the entry and tab attempt if the initial exchange is interrupted', async () => {
  const gate = deferred<void>()
  const test = fixture({ issueResume: true, exchangeGate: gate.promise })
  try {
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/session')).toBe(true))
    const request = test.fetch.mock.calls.find(call => call[0] === '/api/session')!
    const body = JSON.parse(String(request[1].body)) as { token: string; attempt: string }
    expect(body.token).toBe(entryToken)
    expect(body.attempt).toMatch(/^[a-f0-9]{64}$/u)
    expect(test.win.location.hash).toBe(`#${entryToken}`)
    test.beforeUnload()
    test.pageHide()
    expect(await test.manager.ready).toBe(false)
    expect(test.win.location.hash).toBe(`#${entryToken}`)
    expect(test.win.sessionStorage.getItem('cordisx-manager-entry-attempt')).toBe(body.attempt)
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('preserves refresh during bootstrap before bindings or lifecycle exist', async () => {
  const gate = deferred<void>()
  const test = fixture({ issueResume: true, bootstrapGate: gate.promise })
  try {
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/bootstrap')).toBe(true))
    test.beforeUnload()
    test.pageHide()
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/close')).toBe(true))
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    expect(await test.manager.ready).toBe(false)
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('preserves refresh if navigation aborts bootstrap before pagehide', async () => {
  const gate = deferred<void>()
  const test = fixture({ issueResume: true, bootstrapGate: gate.promise })
  try {
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/bootstrap')).toBe(true))
    test.beforeUnload()
    gate.reject(new Error('navigation interrupted bootstrap'))
    expect(await test.manager.ready).toBe(false)
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('preserves refresh while a startup write is queued behind admission', async () => {
  const gate = deferred<void>()
  const test = fixture({ issueResume: true, startGate: gate.promise, modelServices: true })
  try {
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledOnce())
    const target = test.win as unknown as Record<string, any>
    target.__cordisxModelServicesReceiveV1 = vi.fn()
    target.__cordisxModelServicesRequestV1(JSON.stringify({ requestId: 'queued', operation: 'write' }))
    await Promise.resolve()
    test.beforeUnload()
    test.pageHide()
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/close')).toBe(true))
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(false)
    expect(await test.manager.ready).toBe(false)
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('preserves refresh authority if navigation aborts an idle poll before pagehide', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    test.beforeUnload()
    test.failPoll()
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    await test.manager.close()
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retains same-tab recovery when an idle lifecycle poll loses its connection', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    test.failPoll()
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('refresh'))
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/close')).toBe(true))
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not preserve a recovery grant when a dispatched migration is still in flight', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true, holdBindings: true, pluginManagement: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    const target = test.win as unknown as Record<string, any>
    target.__cordisxPluginManagementReceiveV1 = vi.fn()
    target.__cordisxPluginManagementRequestV1(JSON.stringify({
      requestId: 'migration',
      operation: { kind: 'migrate-legacy-sources', input: { sources: [] } },
    }))
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.failPoll()
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('result-unknown'))
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({})
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBeNull()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/binding')).toHaveLength(1)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not preserve a recovery grant after an explicit lifecycle poll denial', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    test.denyPoll()
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledExactlyOnceWith(undefined))
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({})
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBeNull()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not preserve a recovery grant while a lifecycle transaction is reserved', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    test.deliverPoll({
      id: 'e'.repeat(64),
      sequence: 2,
      method: 'prepare',
      payload: { transactionId: 'transaction-1', transactionEpoch: 'transaction-1:1', expectedRegistryEpoch: 3 },
    })
    await vi.waitFor(() =>
      expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(3)
    )
    test.failPoll()
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledExactlyOnceWith(undefined))
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({})
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBeNull()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retains a recovery attempt for an unanswered startup migration without replaying it', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true, holdBindings: true, pluginManagement: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    const target = test.win as unknown as Record<string, any>
    target.__cordisxPluginManagementReceiveV1 = vi.fn()
    target.__cordisxPluginManagementRequestV1(JSON.stringify({
      requestId: 'migration',
      operation: { kind: 'migrate-legacy-sources', input: { sources: [] } },
    }))
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.beforeUnload()
    test.failPoll()
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    await test.manager.close()
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/binding')).toHaveLength(1)
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retains migration recovery when navigation interrupts its response before pagehide', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true, holdBindings: true, pluginManagement: true })
  try {
    expect(await test.manager.ready).toBe(true)
    const target = test.win as unknown as Record<string, any>
    target.__cordisxPluginManagementReceiveV1 = vi.fn()
    target.__cordisxPluginManagementRequestV1(JSON.stringify({
      requestId: 'migration',
      operation: { kind: 'migrate-legacy-sources', input: { sources: [] } },
    }))
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.beforeUnload()
    test.failBinding()
    await vi.waitFor(() => expect(target.__cordisxPluginManagementReceiveV1).toHaveBeenCalledOnce())
    test.pageHide()
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    await test.manager.close()
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not preserve refresh authority while a possible write is in flight', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true, holdBindings: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    Object.assign(test.win, { __cordisxConfigReceiveV1: vi.fn() })
    ;(test.win as unknown as { __cordisxConfigRequestV1(value: string): void }).__cordisxConfigRequestV1(
      JSON.stringify({ requestId: 'pending-write' }),
    )
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.beforeUnload()
    test.failPoll()
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    await test.manager.close()
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({})
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBeNull()
    expect(test.unavailable).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('fences an interrupted permission write when navigation is canceled', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true, holdBindings: true, permissionPolicy: true })
  try {
    expect(await test.manager.ready).toBe(true)
    const target = test.win as unknown as Record<string, any>
    target.__cordisxPermissionPolicyReceiveV1 = vi.fn()
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'permission-write' }))
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.beforeUnload()
    test.failBinding()
    await vi.waitFor(() => expect(target.__cordisxPermissionPolicyReceiveV1).toHaveBeenCalledOnce())
    expect(test.unavailable).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('result-unknown'), {
      timeout: 5_000,
    })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBeNull()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('preserves recovery when an interrupted permission response marks its result unknown during navigation', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true, holdBindings: true, permissionPolicy: true })
  try {
    expect(await test.manager.ready).toBe(true)
    const target = test.win as unknown as Record<string, any>
    target.__cordisxPermissionPolicyReceiveV1 = vi.fn(() => {
      test.reportPermissionUnknown()
      queueMicrotask(() => test.reportPermissionUnknown())
    })
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'permission-write' }))
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.beforeUnload()
    test.failBinding()
    await vi.waitFor(() => expect(target.__cordisxPermissionPolicyReceiveV1).toHaveBeenCalledOnce())
    expect(test.unavailable).not.toHaveBeenCalled()
    test.pageHide()
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    const close = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/close')!
    expect(JSON.parse(String(close[1].body))).toEqual({ preserveResume: true })
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBe('f'.repeat(64))
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('still fences an unrelated unknown result after an interrupted permission response', async () => {
  const test = fixture({ issueResume: true, controlledPoll: true, holdBindings: true, permissionPolicy: true })
  try {
    expect(await test.manager.ready).toBe(true)
    const target = test.win as unknown as Record<string, any>
    target.__cordisxPermissionPolicyReceiveV1 = vi.fn(() => test.reportPermissionUnknown())
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'permission-write' }))
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.beforeUnload()
    test.failBinding()
    await vi.waitFor(() => expect(target.__cordisxPermissionPolicyReceiveV1).toHaveBeenCalledOnce())
    expect(test.unavailable).not.toHaveBeenCalled()
    test.reportResultUnknown()
    expect(test.unavailable).toHaveBeenCalledExactlyOnceWith('result-unknown')
    expect(test.win.sessionStorage.getItem('cordisx-manager-resume-id')).toBeNull()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not acknowledge quiescence while a permission write awaits its result', async () => {
  const test = fixture({ controlledPoll: true, holdBindings: true, permissionPolicy: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    const target = test.win as unknown as Record<string, any>
    target.__cordisxPermissionPolicyReceiveV1 = vi.fn()
    target.__cordisxPermissionPolicyRequestV1(JSON.stringify({ requestId: 'permission-write' }))
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.deliverPoll({ id: 'e'.repeat(64), sequence: 2, method: 'quiesce', payload: { fenceId: 'f'.repeat(64) } })
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledOnce())
    const acknowledgements = test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')
    expect(acknowledgements).toHaveLength(2)
    expect(JSON.parse(String(acknowledgements[1]![1].body))).toMatchObject({ receipt: { ok: false } })
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('revokes bindings and resources before acknowledging an owner quiescence command', async () => {
  const test = fixture({ controlledPoll: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    test.deliverPoll({ id: 'e'.repeat(64), sequence: 2, method: 'quiesce', payload: { fenceId: 'f'.repeat(64) } })
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledOnce())
    const acknowledgements = test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')
    expect(acknowledgements).toHaveLength(2)
    expect(JSON.parse(String(acknowledgements[1]![1].body))).toMatchObject({
      receipt: {
        ok: true,
        value: { fenceId: 'f'.repeat(64), rendererId, ownerGeneration: 'owner-1', quiesced: true },
      },
    })
    expect(test.auth.revokeLocal).toHaveBeenCalled()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
    expect(test.registry.dispose).toHaveBeenCalledOnce()
    expect((test.win as unknown as Record<string, unknown>).__cordisxConfigRequestV1).toBeUndefined()
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/close')).toBe(true)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('refuses a positive quiescence receipt while a possible write is in flight', async () => {
  const test = fixture({ controlledPoll: true, holdBindings: true })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.pollStarted()).toBe(true))
    Object.assign(test.win, { __cordisxConfigReceiveV1: vi.fn() })
    ;(test.win as unknown as { __cordisxConfigRequestV1(value: string): void }).__cordisxConfigRequestV1(
      JSON.stringify({ requestId: 'pending-write' }),
    )
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
    test.deliverPoll({ id: 'e'.repeat(64), sequence: 2, method: 'quiesce', payload: { fenceId: 'f'.repeat(64) } })
    await vi.waitFor(() => expect(test.unavailable).toHaveBeenCalledOnce())
    const acknowledgements = test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')
    expect(acknowledgements).toHaveLength(2)
    expect(JSON.parse(String(acknowledgements[1]![1].body))).toMatchObject({ receipt: { ok: false } })
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('admits a configured graph only when the actual runtime confirms its exact generation', async () => {
  const baseUrl = `${origin}/api/renderer/graphs/${'e'.repeat(64)}/`
  const graph = {
    leaseId: 'f'.repeat(64),
    pluginId: 'channel',
    moduleGeneration: 'channel-1',
    baseUrl,
    entryUrl: `${baseUrl}module.js`,
    initialStyleUrls: [`${baseUrl}style.css`],
  }
  for (
    const [configuredGraphs, ready] of [
      [[{ pluginId: 'channel', moduleGeneration: 'channel-1' }], true],
      [[{ pluginId: 'channel', moduleGeneration: 'other' }], false],
      [[], false],
    ] as const
  ) {
    const test = fixture({ graphs: [graph], configuredGraphs })
    try {
      expect(await test.manager.ready).toBe(ready)
      expect(test.runtime.configuredPluginGraphGenerations).toHaveBeenCalled()
      expect(test.unavailable).toHaveBeenCalledTimes(ready ? 0 : 1)
    } finally {
      await test.manager.close()
      test.dom.window.close()
    }
  }
})

it('authenticates once and admits the existing runtime after synchronizing its actual snapshot', async () => {
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    expect(test.win.location.href).toBe(`${origin}/?host=1`)
    expect(test.start).toHaveBeenCalledOnce()
    expect(typeof (test.win as unknown as Record<string, unknown>).__cordisxConfigRequestV1).toBe('function')
    const paths = test.fetch.mock.calls.map(call => call[0])
    expect(paths.indexOf('/api/renderer/poll')).toBeLessThan(paths.indexOf('/api/renderer/admit'))
    const ack = test.fetch.mock.calls.find(call => call[0] === '/api/renderer/acknowledge')!
    expect(JSON.parse(String(ack[1].body))).toEqual({
      receipt: {
        id: commandId,
        sequence: 1,
        ok: true,
        value: { active: activation, registryEpoch: 3 },
      },
    })
    expect(test.runtime.activePluginGeneration).toHaveBeenCalled()
    expect(test.runtime.pluginRegistryEpoch).toHaveBeenCalled()
    expect(test.importBundle).toHaveBeenCalledWith('/api/renderer/bundle.js')
    for (const [path, options] of test.fetch.mock.calls) {
      expect(path).not.toContain(sessionToken)
      expect(String(options.body)).not.toContain(sessionToken)
      if (path !== '/api/session') {
        expect(options.headers).toMatchObject({ authorization: `Bearer ${sessionToken}` })
      }
    }
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
  expect(test.auth.revokeLocal).toHaveBeenCalledOnce()
  expect(test.runtime.dispose).toHaveBeenCalledOnce()
  expect(test.registry.dispose).toHaveBeenCalledOnce()
  expect(test.unavailable).not.toHaveBeenCalled()
})

it('holds model-service writes until the standalone owner acknowledges admission', async () => {
  const admission = deferred<void>()
  const test = fixture({ modelServices: true, admissionGate: admission.promise, holdBindings: true })
  try {
    const host = test.win as unknown as Record<string, unknown>
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/admit')).toBe(true))
    host.__cordisxModelServicesReceiveV1 = vi.fn()
    ;(host.__cordisxModelServicesRequestV1 as (payload: string) => void)(
      JSON.stringify({ requestId: 'early-save', operation: 'save' }),
    )
    await Promise.resolve()
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(false)
    admission.resolve()
    expect(await test.manager.ready).toBe(true)
    await vi.waitFor(() => expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/binding')).toBe(true))
  } finally {
    admission.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not start the imported composition after owner authority changes', async () => {
  const test = fixture({ invalidSessionAt: 2 })
  try {
    expect(await test.manager.ready).toBe(false)
    await test.manager.close()
    expect(test.importBundle).toHaveBeenCalledOnce()
    expect(test.start).not.toHaveBeenCalled()
    expect(test.auth.revokeLocal).toHaveBeenCalledOnce()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/close')).toHaveLength(1)
    expect(test.unavailable).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('closes during import without allowing a late module to start', async () => {
  const gate = deferred<void>()
  const test = fixture({ importGate: gate.promise })
  try {
    await vi.waitFor(() => expect(test.importBundle).toHaveBeenCalledOnce())
    await test.manager.close()
    gate.resolve()
    expect(await test.manager.ready).toBe(false)
    expect(test.start).not.toHaveBeenCalled()
    expect(test.unavailable).not.toHaveBeenCalled()
    expect(test.auth.revokeLocal).toHaveBeenCalledOnce()
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('disposes a composition that completes after the session was closed', async () => {
  const gate = deferred<void>()
  const test = fixture({ startGate: gate.promise })
  try {
    await vi.waitFor(() => expect(test.start).toHaveBeenCalledOnce())
    await test.manager.close()
    gate.resolve()
    expect(await test.manager.ready).toBe(false)
    await vi.waitFor(() => expect(test.runtime.dispose).toHaveBeenCalledOnce())
    expect(test.registry.dispose).toHaveBeenCalledOnce()
    expect(test.fetch.mock.calls.some(call => call[0] === '/api/renderer/admit')).toBe(false)
  } finally {
    gate.resolve()
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retires the document on a worker controller change without replay or rebind', async () => {
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.serviceWorker.dispatchEvent(new test.win.Event('controllerchange'))
    await vi.waitFor(() => expect(test.auth.revokeLocal).toHaveBeenCalledOnce())
    await test.manager.close()
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
    expect(test.auth.recover).not.toHaveBeenCalled()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('recovers a worker binding only while the owner session remains current', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(false)
    test.auth.recover.mockImplementation(async () => {
      test.auth.isBound.mockResolvedValue(true)
      return true
    })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(test.unavailable).not.toHaveBeenCalled()
    expect(test.auth.recover).toHaveBeenCalledOnce()
    expect(test.runtime.dispose).not.toHaveBeenCalled()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('keeps a live renderer after one interrupted read-only session check', async () => {
  vi.useFakeTimers()
  const test = fixture({ sessionTransportFailuresAt: [4] })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.advanceTimersByTimeAsync(15_200)
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/session')).toHaveLength(5)
    expect(test.unavailable).not.toHaveBeenCalled()
    expect(test.runtime.dispose).not.toHaveBeenCalled()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retires the renderer when the retried session check is still unavailable or no longer current', async () => {
  vi.useFakeTimers()
  for (
    const options of [
      { sessionTransportFailuresAt: [4, 5] },
      { sessionTransportFailuresAt: [4], invalidSessionAt: 5 },
    ]
  ) {
    const test = fixture(options)
    try {
      expect(await test.manager.ready).toBe(true)
      await vi.advanceTimersByTimeAsync(15_200)
      expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/session')).toHaveLength(5)
      expect(test.unavailable).toHaveBeenCalledOnce()
      expect(test.runtime.dispose).toHaveBeenCalledOnce()
    } finally {
      await test.manager.close()
      test.dom.window.close()
    }
  }
})

it('does not retry an explicit unauthorized session response', async () => {
  vi.useFakeTimers()
  const test = fixture({ unauthorizedSessionAt: 4 })
  try {
    expect(await test.manager.ready).toBe(true)
    await vi.advanceTimersByTimeAsync(15_200)
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/session')).toHaveLength(4)
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not rebind after the owner revokes the session', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(false)
    test.revokeSession()
    await vi.advanceTimersByTimeAsync(15_000)
    await test.manager.close()
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.auth.recover).not.toHaveBeenCalled()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('does not rebind when the worker binding check has an uncertain result', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(15_000)
    await test.manager.close()
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.auth.recover).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('retires a renderer if its owner session is revoked during worker recovery', async () => {
  vi.useFakeTimers()
  const test = fixture()
  try {
    expect(await test.manager.ready).toBe(true)
    test.auth.isBound.mockResolvedValue(false)
    test.auth.recover.mockImplementation(async () => {
      test.auth.isBound.mockResolvedValue(true)
      test.revokeSession()
      return true
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await test.manager.close()
    expect(test.auth.recover).toHaveBeenCalledOnce()
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.auth.revokeLocal).toHaveBeenCalledOnce()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('rejects alternate bundle URLs and mismatched owner-projected graphs', async () => {
  const forged = fixture({ bundlePath: '/other.js' })
  const badGraph = {
    leaseId: 'e'.repeat(64),
    pluginId: 'unknown-plugin',
    moduleGeneration: 'v1',
    baseUrl: `${origin}/api/renderer/graphs/${'f'.repeat(64)}/`,
    entryUrl: `${origin}/api/renderer/graphs/${'f'.repeat(64)}/index.js`,
    initialStyleUrls: [],
  }
  const mismatch = fixture({ graphs: [badGraph] })
  try {
    expect(await forged.manager.ready).toBe(false)
    expect(forged.importBundle).not.toHaveBeenCalled()
    expect(await mismatch.manager.ready).toBe(false)
    await mismatch.manager.close()
    expect(mismatch.runtime.dispose).toHaveBeenCalledOnce()
    expect(mismatch.fetch.mock.calls.some(call => call[0] === '/api/renderer/admit')).toBe(false)
  } finally {
    await forged.manager.close()
    await mismatch.manager.close()
    forged.dom.window.close()
    mismatch.dom.window.close()
  }
})

it('does not replay a lifecycle command when acknowledgement is lost', async () => {
  const test = fixture({ loseAck: true })
  try {
    expect(await test.manager.ready).toBe(false)
    await test.manager.close()
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(1)
    expect(test.fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
    expect(test.unavailable).toHaveBeenCalledOnce()
    expect(test.runtime.dispose).toHaveBeenCalledOnce()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})
