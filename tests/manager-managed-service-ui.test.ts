import { describe, expect, it, vi } from 'vitest'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'

const ownerToken = 'owner-private-' + 'a'.repeat(64)
const secondOwnerToken = 'owner-private-' + 'b'.repeat(64)
const binding = {
  bindingId: 'binding-1',
  identity: { source: 'https://plugins.example/sample-provider', pluginId: 'sample-provider', serviceId: 'gateway' },
  scope: { profileId: 'work', generation: 'runtime-1' },
}

function context(id: string, signal: AbortSignal): ManagerRendererChannelContext {
  return { profileId: 'work', rendererId: id.repeat(64), ownerGeneration: 'owner-1', signal }
}

function request(token: string, operation = 'get', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    token,
    requestId: 'request-1',
    operation,
    scope: { profileId: 'work', runtimeGeneration: 'runtime-1', pluginGeneration: 'plugin-1' },
    serviceId: 'gateway',
    ...extra,
  })
}

function descriptor() {
  return {
    status: 'available',
    service: {
      $schema: 'https://example.test/service',
      contract: 'cordisx.managed-service/v1',
      schemaVersion: 1,
      binding,
      webEntry: { url: 'https://internal.example.test' },
      authenticatedConsole: { serviceGeneration: 'generation-1' },
      authenticationTimeoutMs: 300_000,
      capabilities: { logout: true, readCatalog: true, accountControl: true },
    },
  }
}

function fixture(options: { allowAuthentication?: boolean; allowLogout?: boolean } = {}) {
  let epoch = 1
  let live = true
  let capabilities = [{ pluginId: 'sample-provider', pluginGeneration: 'plugin-1', token: ownerToken, startup: true }]
  const handle = vi.fn(async (value: string, _signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const input = JSON.parse(value) as { requestId: string; operation: string }
    return {
      requestId: input.requestId,
      ok: true,
      value: input.operation === 'get' ? descriptor() : { status: 'available', projection: { binding } },
    }
  })
  const bridge = createManagerManagedServiceUIBridge({
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => live,
    readLifecycleFence: () => epoch,
    allowAuthentication: options.allowAuthentication,
    allowLogout: options.allowLogout,
    runtime: { capabilities: () => capabilities, managedServiceUI: { handleBindingValue: handle } },
  })
  return {
    bridge,
    handle,
    advance: () => {
      epoch++
    },
    disconnect: () => {
      live = false
    },
    replace: () => {
      capabilities = [{ ...capabilities[0]!, token: secondOwnerToken }]
    },
  }
}

describe('manager managed-service UI bridge', () => {
  it('rejects an owner token in a bundle and retires only the requested session', () => {
    const { bridge } = fixture()
    const a = context('1', new AbortController().signal)
    const b = context('2', new AbortController().signal)
    const aToken = bridge.projectInitial(a)[0]!.token
    const bToken = bridge.projectInitial(b)[0]!.token
    expect(() => bridge.assertBundleSafe(a, `fixture:${aToken}`)).not.toThrow()
    expect(() => bridge.assertBundleSafe(a, `fixture:${ownerToken}`)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    bridge.retire(a)
    expect(() => bridge.assertBundleSafe(a, 'fixture')).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(() => bridge.assertBundleSafe(b, `fixture:${bToken}`)).not.toThrow()
    bridge.dispose()
  })

  it('projects isolated aliases, forwards the native request, and removes unsupported capabilities', async () => {
    const { bridge, handle } = fixture()
    const a = context('1', new AbortController().signal)
    const b = context('2', new AbortController().signal)
    const aToken = bridge.projectInitial(a)[0]!.token
    const bToken = bridge.projectInitial(b)[0]!.token
    expect(aToken).not.toBe(bToken)
    expect(JSON.stringify(bridge.projectInitial(a))).not.toContain(ownerToken)
    const result = await bridge.channel.prepare(request(aToken), a).dispatch()
    expect(result).toEqual({
      requestId: 'request-1',
      ok: true,
      value: {
        status: 'available',
        service: {
          $schema: 'https://example.test/service',
          contract: 'cordisx.managed-service/v1',
          schemaVersion: 1,
          binding,
          capabilities: { logout: false, readCatalog: true, accountControl: false },
        },
      },
    })
    expect(JSON.parse(handle.mock.calls[0]![0]).token).toBe(ownerToken)
    expect(handle.mock.calls[0]![1]).toBe(a.signal)
    expect(JSON.stringify(result)).not.toContain(ownerToken)
    expect(() => bridge.channel.prepare(request(aToken), b)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    const snapshot = await bridge.channel.prepare(request(bToken, 'snapshot', { binding }), b).dispatch()
    expect(snapshot).toMatchObject({ ok: true, value: { status: 'available' } })
    bridge.dispose()
  })

  it('rejects spoofed scope, generation, binding and unknown request fields', () => {
    const { bridge, handle } = fixture()
    const a = context('1', new AbortController().signal)
    const token = bridge.projectInitial(a)[0]!.token
    const inputs = [
      request(token, 'get', {
        scope: { profileId: 'other', runtimeGeneration: 'runtime-1', pluginGeneration: 'plugin-1' },
      }),
      request(token, 'get', {
        scope: { profileId: 'work', runtimeGeneration: 'runtime-1', pluginGeneration: 'other' },
      }),
      request(token, 'get', { pluginId: 'other' }),
      request(token, 'snapshot', { binding: { ...binding, identity: { ...binding.identity, pluginId: 'other' } } }),
      request(ownerToken),
    ]
    for (const value of inputs) expect(() => bridge.channel.prepare(value, a)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(handle).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('explicitly refuses stateful actions without invoking the backend', async () => {
    const { bridge, handle } = fixture()
    const a = context('1', new AbortController().signal)
    const token = bridge.projectInitial(a)[0]!.token
    for (
      const operation of [
        'authenticate',
        'logout',
        'startOAuth',
        'readWebEntry',
        'consoleView',
        'toggleAccount',
      ]
    ) {
      const result = await bridge.channel.prepare(request(token, operation), a).dispatch()
      expect(result).toEqual({ requestId: 'request-1', ok: false, code: 'unsupported' })
    }
    expect(handle).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('checks logout capability before dispatch and confirms the resulting state', async () => {
    const { bridge, handle } = fixture({ allowLogout: true })
    const a = { ...context('1', new AbortController().signal), admitted: true }
    const token = bridge.projectInitial(a)[0]!.token
    let supported = false
    let sequence = 2
    let state = 'authenticated'
    const logout = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
      contract: 'cordisx.managed-service-logout-request/v1',
      schemaVersion: 1,
      requestId: 'logout-1',
      binding,
      action: 'logout',
      expectedSequence: 2,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    }
    handle.mockImplementation(async value => {
      const input = JSON.parse(value) as { requestId: string; operation: string }
      if (input.operation === 'logout') {
        sequence = 3
        state = 'logged-out'
        return {
          requestId: input.requestId,
          ok: true,
          value: {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-result.v1.schema.json',
            contract: 'cordisx.managed-service-logout-result/v1',
            schemaVersion: 1,
            requestId: logout.requestId,
            binding,
            status: 'accepted',
            stateAt: 'logged-out',
            sequence,
          },
        }
      }
      return {
        requestId: input.requestId,
        ok: true,
        value: input.operation === 'get' ? descriptor() : {
          status: 'available',
          projection: { binding, sequence, auth: { state }, capabilities: { logout: supported } },
        },
      }
    })
    try {
      expect(await bridge.channel.prepare(request(token), a).dispatch()).toMatchObject({
        value: { service: { capabilities: { logout: false } } },
      })
      const denied = bridge.channel.prepare(request(token, 'logout', { binding, request: logout }), a)
      expect(await denied.dispatch()).toMatchObject({ value: { status: 'denied', error: { code: 'unsupported' } } })
      expect(handle.mock.calls.map(([value]) => JSON.parse(value).operation)).not.toContain('logout')
      supported = true
      expect(await bridge.channel.prepare(request(token), a).dispatch()).toMatchObject({
        value: { service: { capabilities: { logout: true } } },
      })
      const action = bridge.channel.prepare(
        request(token, 'logout', {
          requestId: 'request-2',
          binding,
          request: logout,
        }),
        a,
      )
      expect(action.mode).toBe('write')
      expect(action.managedServiceAuthentication).toMatchObject({ action: 'logout', expectedSequence: 2 })
      expect(await action.dispatch()).toMatchObject({ ok: true, value: { status: 'accepted', stateAt: 'logged-out' } })
      expect(handle.mock.calls.filter(([value]) => JSON.parse(value).operation === 'logout')).toHaveLength(1)
    } finally {
      bridge.dispose()
    }
  })

  it('admits one scoped login only after confirming the resulting service snapshot', async () => {
    const { bridge, handle } = fixture({ allowAuthentication: true })
    const a = { ...context('1', new AbortController().signal), admitted: true }
    const token = bridge.projectInitial(a)[0]!.token
    const login = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
      contract: 'cordisx.managed-service-login-request/v1',
      schemaVersion: 1,
      requestId: 'login-1',
      binding,
      action: 'login',
      expectedSequence: 2,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    }
    handle.mockImplementation(async value => {
      const input = JSON.parse(value) as { requestId: string; operation: string }
      return {
        requestId: input.requestId,
        ok: true,
        value: input.operation === 'get' ? descriptor() : input.operation === 'authenticate'
          ? {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-result.v1.schema.json',
            contract: 'cordisx.managed-service-login-result/v1',
            schemaVersion: 1,
            requestId: login.requestId,
            binding,
            status: 'accepted',
            stateAt: 'authenticated',
            sequence: 3,
          }
          : { status: 'available', projection: { binding, sequence: 4, auth: { state: 'authenticated' } } },
      }
    })
    try {
      const available = await bridge.channel.prepare(request(token), a).dispatch()
      expect(available).toMatchObject({ value: { service: { authenticationTimeoutMs: 300_000 } } })
      const action = bridge.channel.prepare(request(token, 'authenticate', { binding, request: login }), a)
      expect(action.mode).toBe('write')
      expect(await action.dispatch()).toMatchObject({ ok: true, value: { status: 'accepted', sequence: 3 } })
      expect(handle.mock.calls.map(([value]) => JSON.parse(value).operation)).toEqual([
        'get',
        'authenticate',
        'snapshot',
      ])
      await expect(action.dispatch()).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      expect(() =>
        bridge.channel.prepare(request(token, 'authenticate', { binding, request: login }), {
          ...a,
          admitted: false,
        })
      ).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    } finally {
      bridge.dispose()
    }
  })

  it('does not return a successful login when its owner snapshot cannot confirm it', async () => {
    const { bridge, handle } = fixture({ allowAuthentication: true })
    const a = { ...context('1', new AbortController().signal), admitted: true }
    const token = bridge.projectInitial(a)[0]!.token
    const login = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
      contract: 'cordisx.managed-service-login-request/v1',
      schemaVersion: 1,
      requestId: 'login-2',
      binding,
      action: 'login',
      expectedSequence: 0,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    }
    let failed = false
    handle.mockImplementation(async value => {
      const input = JSON.parse(value) as { requestId: string; operation: string }
      return {
        requestId: input.requestId,
        ok: true,
        value: input.operation === 'authenticate'
          ? {
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-result.v1.schema.json',
            contract: 'cordisx.managed-service-login-result/v1',
            schemaVersion: 1,
            requestId: login.requestId,
            binding,
            ...(failed
              ? { status: 'failed', error: { code: 'authentication-failed', message: 'private diagnostic' } }
              : { status: 'accepted', stateAt: 'authenticated', sequence: 1 }),
          }
          : { status: 'available', projection: { binding, sequence: 2, auth: { state: 'missing' } } },
      }
    })
    try {
      await expect(
        bridge.channel.prepare(request(token, 'authenticate', { binding, request: login }), a).dispatch(),
      ).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      failed = true
      await expect(
        bridge.channel.prepare(request(token, 'authenticate', { requestId: 'next', binding, request: login }), a)
          .dispatch(),
      ).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    } finally {
      bridge.dispose()
    }
  })

  it('retires on abort, token replacement, owner loss or a lifecycle fence change', () => {
    for (const trigger of ['abort', 'replace', 'disconnect', 'advance'] as const) {
      const { bridge, replace, disconnect, advance } = fixture()
      const controller = new AbortController()
      const a = context('1', controller.signal)
      const token = bridge.projectInitial(a)[0]!.token
      if (trigger === 'abort') controller.abort()
      if (trigger === 'replace') replace()
      if (trigger === 'disconnect') disconnect()
      if (trigger === 'advance') advance()
      expect(() => bridge.channel.prepare(request(token), a)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      expect(() => bridge.projectInitial(a)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      bridge.dispose()
    }
  })

  it('rejects forged and oversized results without exposing owner tokens or exception text', async () => {
    const { bridge, handle } = fixture()
    const a = context('1', new AbortController().signal)
    const token = bridge.projectInitial(a)[0]!.token
    const badValues = [
      { nested: `value:${ownerToken}` },
      { nested: { token: 'redact-even-if-not-the-route-token' } },
      { nested: 'x'.repeat(300_000) },
    ]
    for (const value of badValues) {
      handle.mockResolvedValueOnce({ requestId: 'request-1', ok: true, value })
      await expect(bridge.channel.prepare(request(token, 'snapshot', { binding }), a).dispatch())
        .rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    }
    handle.mockRejectedValueOnce(new Error(`internal failure ${ownerToken}`))
    await expect(bridge.channel.prepare(request(token, 'snapshot', { binding }), a).dispatch())
      .rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    handle.mockResolvedValueOnce({
      toJSON: () => {
        throw new Error(`internal failure ${ownerToken}`)
      },
    })
    await expect(bridge.channel.prepare(request(token, 'snapshot', { binding }), a).dispatch())
      .rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    bridge.dispose()
  })

  it('suppresses in-flight read results when the epoch changes, including rollback to the same capability', async () => {
    const { bridge, handle, advance } = fixture()
    const a = context('1', new AbortController().signal)
    const token = bridge.projectInitial(a)[0]!.token
    let finish!: (value: Record<string, unknown>) => void
    handle.mockImplementationOnce(async () =>
      await new Promise(resolve => {
        finish = resolve
      })
    )
    const pending = bridge.channel.prepare(request(token), a).dispatch()
    advance()
    advance()
    finish({ requestId: 'request-1', ok: true, value: descriptor() })
    await expect(pending).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    bridge.dispose()
  })

  it('follows actual ManagerRendererSessions close and suppresses in-flight results', async () => {
    const { bridge, handle } = fixture()
    const gateway = { pid: 42, processStartedAt: 'start', instanceToken: 'c'.repeat(64) }
    const sessions = new ManagerRendererSessions({
      profileId: 'work',
      ownerGeneration: 'owner-1',
      ownerCurrent: () => true,
      authenticateGateway: async () => true,
      channels: new Map([
        ['bootstrap', {
          prepare: (_payload, ctx) => ({ mode: 'read' as const, dispatch: async () => bridge.projectInitial(ctx) }),
        }],
        ['managed', bridge.channel],
      ]),
    })
    const browserSessionId = 'd'.repeat(64)
    const ownerHandle = await sessions.open(gateway, browserSessionId)
    const invocation = { gateway, browserSessionId, handle: ownerHandle! }
    const bootstrap = await sessions.call(invocation, 'bootstrap', {})
    expect(bootstrap.status).toBe('ok')
    if (bootstrap.status !== 'ok') throw new Error('bootstrap failed')
    const token = (bootstrap.value as Array<{ token: string }>)[0]!.token
    let finish!: (value: Record<string, unknown>) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    handle.mockImplementationOnce(async () => {
      entered()
      return await new Promise(resolve => {
        finish = resolve
      })
    })
    const pending = sessions.call(invocation, 'managed', request(token))
    await started
    try {
      let retired = false
      const closing = sessions.close(invocation).then(result => {
        retired = true
        return result
      })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(retired).toBe(false)
      finish({ requestId: 'request-1', ok: true, value: descriptor() })
      expect(await pending).toEqual({ status: 'unavailable' })
      expect(await closing).toBe(true)
      expect(await sessions.call(invocation, 'managed', request(token))).toEqual({ status: 'unavailable' })
    } finally {
      finish({ requestId: 'request-1', ok: true, value: descriptor() })
      sessions.dispose()
      bridge.dispose()
    }
  })
})
