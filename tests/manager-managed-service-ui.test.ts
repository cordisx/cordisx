import { describe, expect, it, vi } from 'vitest'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'

const ownerToken = 'owner-private-' + 'a'.repeat(64)
const secondOwnerToken = 'owner-private-' + 'b'.repeat(64)
const binding = {
  bindingId: 'binding-1',
  identity: { source: 'https://plugins.example/aiden', pluginId: 'aiden', serviceId: 'gateway' },
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

function fixture() {
  let epoch = 1
  let live = true
  let capabilities = [{ pluginId: 'aiden', pluginGeneration: 'plugin-1', token: ownerToken, startup: true }]
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
        'subscribe',
        'next',
        'authenticate',
        'logout',
        'startOAuth',
        'readWebEntry',
        'consoleView',
        'startupSubscribe',
        'toggleAccount',
      ]
    ) {
      const result = await bridge.channel.prepare(request(token, operation), a).dispatch()
      expect(result).toEqual({ requestId: 'request-1', ok: false, code: 'unsupported' })
    }
    expect(handle).not.toHaveBeenCalled()
    bridge.dispose()
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
    await sessions.close(invocation)
    finish({ requestId: 'request-1', ok: true, value: descriptor() })
    expect(await pending).toEqual({ status: 'unavailable' })
    expect(await sessions.call(invocation, 'managed', request(token))).toEqual({ status: 'unavailable' })
    sessions.dispose()
    bridge.dispose()
  })
})
