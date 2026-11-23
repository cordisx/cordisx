import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createManagerManagedServiceAccountToggle } from '../packages/cli/src/cli/manager-managed-service-account-toggle.js'
import { coordinateManagerManagedServiceMutations } from '../packages/cli/src/cli/manager-managed-service-mutation.js'
import { ManagerManagedServiceUIGate } from '../packages/cli/src/cli/manager-managed-service-ui-gate.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

const secret = () => randomBytes(32).toString('hex')
const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
const binding = {
  bindingId: 'binding-1',
  identity: { pluginId: 'example', serviceId: 'gateway' },
  scope: { profileId: 'work', generation: 'owner-1' },
}
const request = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-account-toggle.v1.schema.json' as const,
  contract: 'cordisx.managed-service-cli-proxy-account-toggle/v1' as const,
  schemaVersion: 1 as const,
  requestId: 'toggle-1',
  binding,
  accountId: 'account-1',
  disabled: true,
  expectedRevision: 4,
  userGesture: { kind: 'explicit-click' as const, at: '2026-01-01T00:00:00Z' },
}
const projection = (disabled: boolean) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-accounts.v1.schema.json' as const,
  contract: 'cordisx.managed-service-cli-proxy-accounts/v1' as const,
  schemaVersion: 1 as const,
  binding,
  sequence: 1,
  observedAt: '2026-01-01T00:00:00Z',
  revision: disabled ? 5 : 4,
  serviceGeneration: 'service-1',
  accounts: [{
    accountId: 'account-1',
    authIndex: 'index-1',
    provider: 'codex' as const,
    label: 'Example',
    status: 'active' as const,
    disabled,
    unavailable: false,
    authKind: 'oauth' as const,
    sourceKind: 'memory' as const,
    runtimeOnly: false,
  }],
})

function fixture() {
  const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' }
  const lifecycle = new ServiceRendererLifecycle({
    scope,
    projectMutation: async () => {
      throw new Error('unused')
    },
  })
  lifecycle.initialize({
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: scope.profileId,
    runtimeGeneration: scope.generation,
    revision: 0,
    lastGoodRevision: 0,
    plugins: [],
  })
  const participants = new ServiceRendererParticipants(scope)
  participants.bind(lifecycle)
  const gate = new ManagerManagedServiceUIGate()
  let sessions!: ManagerRendererSessions
  let disabled = false
  let available = true
  const reservation = { fenced: false, released: false }
  const toggle = vi.fn(async () => {
    disabled = true
    return {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-account-toggle-result.v1.schema.json' as const,
      contract: 'cordisx.managed-service-cli-proxy-account-toggle-result/v1' as const,
      schemaVersion: 1 as const,
      requestId: request.requestId,
      binding,
      status: 'accepted' as const,
      accountId: request.accountId,
      disabled,
      sequence: 2,
    }
  })
  const action = createManagerManagedServiceAccountToggle({
    identity: { pluginId: 'example', pluginGeneration: 'plugin-1', serviceId: 'gateway' },
    requestId: 'outer-1',
    request,
    preparePlan: async () => ({
      operations: [{ operationId: 'toggle', value: { disabled: true }, maxInvocations: 1 }],
    }),
    readAccounts: async () => ({ status: 'available', accounts: projection(disabled) }),
    toggle,
  })
  const channel = coordinateManagerManagedServiceMutations({
    channel: { prepare: () => ({ mode: 'write', managedServiceAccountToggle: action, dispatch: async () => ({}) }) },
    sessions: () => sessions,
    participants,
    lifecycle,
    reserveAccountUI: async current => await gate.reserve(current),
    reserveServiceClients: () =>
      available
        ? {
          isCurrent: () => !reservation.fenced && !reservation.released,
          release: () => {
            reservation.released = true
            return true
          },
          fence: () => {
            reservation.fenced = true
          },
          runBorrowed: async (_policy, callback) => await callback(),
        }
        : undefined,
  })
  sessions = new ManagerRendererSessions({
    profileId: scope.profileId,
    ownerGeneration: scope.generation,
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: participants.participant,
    channels: new Map([['managed-service-ui', channel]]),
  })
  const open = async () => {
    const browserSessionId = secret()
    const handle = (await sessions.open(gateway, browserSessionId))!
    const invocation = { gateway, browserSessionId, handle }
    participants.confirmBootstrap(handle.rendererId, lifecycle.snapshot())
    const admission = sessions.admit(invocation)
    const peer = participants.peer(handle.rendererId)!
    const synchronize = (await peer.next())!
    expect(
      peer.acknowledge({ id: synchronize.id, sequence: synchronize.sequence, ok: true, value: synchronize.payload }),
    ).toBe(true)
    expect(await admission).toMatchObject({ status: 'ok' })
    return { invocation, peer }
  }
  return {
    lifecycle,
    participants,
    sessions,
    gate,
    open,
    toggle,
    reservation,
    busy: () => {
      available = false
    },
  }
}

function receipt(command: { payload: unknown }, confirmed = true) {
  const value = command.payload as {
    rendererId: string
    ownerGeneration: string
    requestId: string
    pluginId: string
    pluginGeneration: string
    serviceId: string
    phase: string
    accounts?: { revision: number }
  }
  return {
    rendererId: value.rendererId,
    ownerGeneration: value.ownerGeneration,
    requestId: value.requestId,
    pluginId: value.pluginId,
    pluginGeneration: value.pluginGeneration,
    serviceId: value.serviceId,
    phase: value.phase,
    revision: value.accounts?.revision ?? null,
    confirmed,
  }
}

it('waits for both Managers before and after an account toggle', async () => {
  const f = fixture()
  try {
    const first = await f.open()
    const second = await f.open()
    const result = f.sessions.call(first.invocation, 'managed-service-ui', JSON.stringify({ requestId: 'outer-1' }))
    const before = await Promise.all([first.peer.next(), second.peer.next()])
    expect(before.every(item => item?.method === 'managed-service-accounts')).toBe(true)
    expect(f.toggle).not.toHaveBeenCalled()
    expect(await f.sessions.open(gateway, secret())).toBeUndefined()
    for (const [index, peer] of [first.peer, second.peer].entries()) {
      const item = before[index]!
      expect(peer.acknowledge({ id: item.id, sequence: item.sequence, ok: true, value: receipt(item) })).toBe(true)
    }
    const after = await Promise.all([first.peer.next(), second.peer.next()])
    expect(f.toggle).toHaveBeenCalledOnce()
    for (const [index, peer] of [first.peer, second.peer].entries()) {
      const item = after[index]!
      expect(receipt(item)).toMatchObject({ phase: 'confirm', revision: 5 })
      expect(peer.acknowledge({ id: item.id, sequence: item.sequence, ok: true, value: receipt(item) })).toBe(true)
    }
    expect(await result).toMatchObject({ status: 'ok', value: { ok: true, value: { status: 'accepted' } } })
    expect(f.reservation).toEqual({ fenced: false, released: true })
    expect(f.gate.open).toBe(true)
  } finally {
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('does not dispatch while the service has an unreserved client', async () => {
  const f = fixture()
  try {
    const first = await f.open()
    f.busy()
    expect(await f.sessions.call(first.invocation, 'managed-service-ui', JSON.stringify({ requestId: 'outer-1' })))
      .toEqual({ status: 'ok', value: { requestId: 'outer-1', ok: false, code: 'owner-unavailable' } })
    expect(f.toggle).not.toHaveBeenCalled()
    expect(f.gate.open).toBe(true)
  } finally {
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('fences an applied action when a Manager cannot confirm the new account state', async () => {
  const f = fixture()
  try {
    const first = await f.open()
    const second = await f.open()
    const result = f.sessions.call(first.invocation, 'managed-service-ui', JSON.stringify({ requestId: 'outer-1' }))
    const before = await Promise.all([first.peer.next(), second.peer.next()])
    for (const [index, peer] of [first.peer, second.peer].entries()) {
      const item = before[index]!
      peer.acknowledge({ id: item.id, sequence: item.sequence, ok: true, value: receipt(item) })
    }
    const after = await Promise.all([first.peer.next(), second.peer.next()])
    first.peer.acknowledge({ id: after[0]!.id, sequence: after[0]!.sequence, ok: true, value: receipt(after[0]!) })
    second.peer.acknowledge({
      id: after[1]!.id,
      sequence: after[1]!.sequence,
      ok: true,
      value: receipt(after[1]!, false),
    })
    expect(await result).toEqual({ status: 'unknown' })
    expect(f.reservation.fenced).toBe(true)
    expect(f.lifecycle.requiresReconciliation).toBe(true)
  } finally {
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('does not dispatch an account change when a Manager disconnects during preparation', async () => {
  const f = fixture()
  try {
    const first = await f.open()
    const second = await f.open()
    const result = f.sessions.call(first.invocation, 'managed-service-ui', JSON.stringify({ requestId: 'outer-1' }))
    const before = await Promise.all([first.peer.next(), second.peer.next()])
    first.peer.acknowledge({ id: before[0]!.id, sequence: before[0]!.sequence, ok: true, value: receipt(before[0]!) })
    second.peer.close()
    expect(await result).toEqual({ status: 'unknown' })
    expect(f.toggle).not.toHaveBeenCalled()
    expect(f.reservation.fenced).toBe(true)
    expect(f.lifecycle.requiresReconciliation).toBe(true)
  } finally {
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})

it('reports an uncertain result when a Manager disconnects after an account change', async () => {
  const f = fixture()
  try {
    const first = await f.open()
    const second = await f.open()
    const result = f.sessions.call(first.invocation, 'managed-service-ui', JSON.stringify({ requestId: 'outer-1' }))
    const before = await Promise.all([first.peer.next(), second.peer.next()])
    for (const [index, peer] of [first.peer, second.peer].entries()) {
      const item = before[index]!
      peer.acknowledge({ id: item.id, sequence: item.sequence, ok: true, value: receipt(item) })
    }
    const after = await Promise.all([first.peer.next(), second.peer.next()])
    expect(f.toggle).toHaveBeenCalledOnce()
    first.peer.acknowledge({ id: after[0]!.id, sequence: after[0]!.sequence, ok: true, value: receipt(after[0]!) })
    second.peer.close()
    expect(await result).toEqual({ status: 'unknown' })
    expect(f.reservation.fenced).toBe(true)
    expect(f.lifecycle.requiresReconciliation).toBe(true)
  } finally {
    f.sessions.dispose()
    f.participants.close()
    await f.lifecycle.close()
  }
})
