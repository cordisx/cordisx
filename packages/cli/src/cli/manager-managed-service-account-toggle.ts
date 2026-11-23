import type {
  ManagedServiceBindingV1,
  ManagedServiceCliProxyAccountsResultV1,
  ManagedServiceCliProxyAccountsV1,
  ManagedServiceCliProxyAccountToggleRequestV1,
  ManagedServiceCliProxyAccountToggleResultV1,
} from '@cordisx/protocol/managed-service/v1'
import type {
  ManagedServiceClientIdentity,
  ManagedServiceClientReservation,
} from '../launcher/managed-service-client-reservation.js'
import type { ManagerManagedServiceUIGate } from './manager-managed-service-ui-gate.js'
import { managedAccountToggleBorrowPolicy } from './manager-managed-service-account-plan.js'

type UIReservation = Awaited<ReturnType<ManagerManagedServiceUIGate['reserve']>>
type Outcome =
  | { readonly status: 'unavailable' }
  | { readonly status: 'denied'; readonly result: ManagedServiceCliProxyAccountToggleResultV1 }
  | {
    readonly status: 'applied'
    readonly result: ManagedServiceCliProxyAccountToggleResultV1
    readonly accounts: ManagedServiceCliProxyAccountsV1
  }

export interface ManagerManagedServiceAccountToggle {
  readonly identity: ManagedServiceClientIdentity
  readonly requestId: string
  readonly binding: ManagedServiceBindingV1
  run(input: {
    readonly clients: ManagedServiceClientReservation
    readonly ui: UIReservation
    readonly isCurrent: () => boolean
    readonly preparePeers: (accounts: ManagedServiceCliProxyAccountsV1) => Promise<boolean>
  }): Promise<Outcome>
}

/** Bind an exact request to one owner source; the caller still coordinates all renderer receipts. */
export function createManagerManagedServiceAccountToggle(input: {
  readonly identity: ManagedServiceClientIdentity
  readonly requestId: string
  readonly request: ManagedServiceCliProxyAccountToggleRequestV1
  readonly preparePlan: () => Promise<unknown>
  readonly readAccounts: () => Promise<ManagedServiceCliProxyAccountsResultV1>
  readonly toggle: () => Promise<ManagedServiceCliProxyAccountToggleResultV1>
}): ManagerManagedServiceAccountToggle {
  const request = structuredClone(input.request)
  const identity = Object.freeze({ ...input.identity })
  const denied = (): ManagedServiceCliProxyAccountToggleResultV1 => ({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-account-toggle-result.v1.schema.json',
    contract: 'cordisx.managed-service-cli-proxy-account-toggle-result/v1',
    schemaVersion: 1,
    requestId: request.requestId,
    binding: request.binding,
    status: 'denied',
    error: { code: 'stale-revision', message: 'Account state changed; refresh before trying again.' },
  })
  return Object.freeze({
    identity,
    requestId: input.requestId,
    binding: structuredClone(request.binding),
    async run(
      { clients, ui, isCurrent, preparePeers }: Parameters<ManagerManagedServiceAccountToggle['run']>[0],
    ): Promise<Outcome> {
      const current = () => isCurrent() && clients.isCurrent() && ui.isCurrent()
      if (!current() || !clients.runBorrowed) throw new Error('managed-account-toggle-unavailable')
      return await ui.run(async () => {
        const plan = await input.preparePlan()
        if (!current()) throw new Error('managed-account-toggle-unavailable')
        const policy = managedAccountToggleBorrowPolicy(plan, current)
        return await clients.runBorrowed!(policy, async () => {
          const before = await input.readAccounts()
          if (!current()) throw new Error('managed-account-toggle-unavailable')
          if (before.status !== 'available') return { status: 'unavailable' as const }
          const matches = before.accounts.accounts.filter(account => account.accountId === request.accountId)
          const account = matches[0]
          if (
            before.accounts.revision !== request.expectedRevision || matches.length !== 1 || !account
            || account.unavailable || account.disabled === request.disabled
            || request.authIndex !== undefined && request.authIndex !== account.authIndex
          ) return { status: 'denied' as const, result: denied() }
          if (!await preparePeers(before.accounts)) return { status: 'unavailable' as const }
          if (!current()) throw new Error('managed-account-toggle-unavailable')
          const result = await input.toggle()
          if (!current()) throw new Error('managed-account-toggle-unavailable')
          if (result.status === 'denied') return { status: 'denied' as const, result }
          if (result.status !== 'accepted') throw new Error('managed-account-toggle-uncertain')
          const after = await input.readAccounts()
          if (!current() || after.status !== 'available') throw new Error('managed-account-toggle-uncertain')
          const updated = after.accounts.accounts.filter(item => item.accountId === request.accountId)
          if (
            after.accounts.serviceGeneration !== before.accounts.serviceGeneration
            || after.accounts.revision === before.accounts.revision || updated.length !== 1
            || updated[0]!.disabled !== request.disabled || updated[0]!.authIndex !== account.authIndex
          ) throw new Error('managed-account-toggle-uncertain')
          return { status: 'applied' as const, result, accounts: after.accounts }
        })
      })
    },
  })
}
