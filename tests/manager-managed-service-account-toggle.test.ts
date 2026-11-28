import { expect, it, vi } from 'vitest'
import { createManagerManagedServiceAccountToggle } from '../packages/cli/src/cli/manager-managed-service-account-toggle.js'
import { ManagerManagedServiceUIGate } from '../packages/cli/src/cli/manager-managed-service-ui-gate.js'
import type { ManagedServiceClientBorrowPolicy } from '../packages/cli/src/launcher/managed-service-client-reservation.js'

const binding = {
  bindingId: 'binding-1',
  identity: { pluginId: 'example', serviceId: 'gateway' },
  scope: { profileId: 'default', generation: 'owner-1' },
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
  expectedRevision: 5,
  userGesture: { kind: 'explicit-click' as const, at: '2026-01-01T00:00:00Z' },
}
const account = {
  accountId: 'account-1',
  authIndex: 'index-1',
  provider: 'codex' as const,
  label: 'Example',
  status: 'active' as const,
  disabled: false,
  unavailable: false,
  authKind: 'oauth' as const,
  sourceKind: 'memory' as const,
  runtimeOnly: false,
}
const projection = (disabled: boolean, revision: number) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-accounts.v1.schema.json' as const,
  contract: 'cordisx.managed-service-cli-proxy-accounts/v1' as const,
  schemaVersion: 1 as const,
  binding,
  sequence: 1,
  observedAt: '2026-01-01T00:00:00Z',
  revision,
  serviceGeneration: 'service-1',
  accounts: [{ ...account, disabled }],
})
const accepted = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-account-toggle-result.v1.schema.json' as const,
  contract: 'cordisx.managed-service-cli-proxy-account-toggle-result/v1' as const,
  schemaVersion: 1 as const,
  requestId: request.requestId,
  binding,
  status: 'accepted' as const,
  accountId: request.accountId,
  disabled: true,
  sequence: 2,
}

function fixture(before = projection(false, 5), after = projection(true, 4)) {
  let activePolicy: ManagedServiceClientBorrowPolicy | undefined
  const readAccounts = vi.fn()
    .mockResolvedValueOnce({ status: 'available', accounts: before })
    .mockResolvedValueOnce({ status: 'available', accounts: after })
  const toggle = vi.fn(async () => accepted)
  const action = createManagerManagedServiceAccountToggle({
    identity: { pluginId: 'example', pluginGeneration: 'plugin-1', serviceId: 'gateway' },
    requestId: 'outer-1',
    request,
    preparePlan: async () => ({
      operations: [{ operationId: 'accounts.toggle', value: { disabled: true }, maxInvocations: 1 }],
    }),
    readAccounts,
    toggle,
  })
  const clients = {
    isCurrent: () => true,
    release: () => true,
    fence: () => {},
    runBorrowed: async <T>(policy: ManagedServiceClientBorrowPolicy, callback: () => Promise<T>) => {
      activePolicy = policy
      return await callback()
    },
  }
  return { action, clients, readAccounts, toggle, policy: () => activePolicy }
}

it('confirms the exact changed account even when the opaque revision decreases', async () => {
  const f = fixture()
  const ui = await new ManagerManagedServiceUIGate().reserve(() => true)
  const outcome = await f.action.run({ clients: f.clients, ui, isCurrent: () => true, preparePeers: async () => true })
  expect(outcome).toMatchObject({ status: 'applied', accounts: { revision: 4 } })
  expect(f.readAccounts).toHaveBeenCalledTimes(2)
  expect(f.toggle).toHaveBeenCalledOnce()
  expect(f.policy()!.allows('accounts.toggle', { disabled: true })).toBe(true)
  expect(f.policy()!.allows('accounts.toggle', { disabled: false })).toBe(false)
  expect(ui.release()).toBe(true)
})

it('rejects a stale account revision before dispatching a mutation', async () => {
  const f = fixture(projection(false, 6))
  const ui = await new ManagerManagedServiceUIGate().reserve(() => true)
  expect(await f.action.run({ clients: f.clients, ui, isCurrent: () => true, preparePeers: async () => true }))
    .toMatchObject({
      status: 'denied',
      result: { status: 'denied', error: { code: 'stale-revision' } },
    })
  expect(f.toggle).not.toHaveBeenCalled()
  expect(ui.release()).toBe(true)
})

it('does not dispatch when a peer cannot adopt the current account state', async () => {
  const f = fixture()
  const ui = await new ManagerManagedServiceUIGate().reserve(() => true)
  expect(await f.action.run({ clients: f.clients, ui, isCurrent: () => true, preparePeers: async () => false }))
    .toEqual({ status: 'unavailable' })
  expect(f.toggle).not.toHaveBeenCalled()
  expect(ui.release()).toBe(true)
})

it('does not claim success when the owner readback did not adopt the requested state', async () => {
  const f = fixture(projection(false, 5), projection(false, 6))
  const ui = await new ManagerManagedServiceUIGate().reserve(() => true)
  await expect(f.action.run({ clients: f.clients, ui, isCurrent: () => true, preparePeers: async () => true }))
    .rejects.toThrow('managed-account-toggle-uncertain')
  expect(f.toggle).toHaveBeenCalledOnce()
  ui.fence()
})
