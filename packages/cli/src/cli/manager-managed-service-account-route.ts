import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ManagedServiceUIBindingRequest, ManagedServiceUIOwner } from '../launcher/managed-service-ui-rpc.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { ManagerManagedServiceAccounts } from './manager-managed-service-accounts.js'
import { createManagerManagedServiceAccountToggle } from './manager-managed-service-account-toggle.js'

type Toggle = Extract<ManagedServiceUIBindingRequest, { readonly operation: 'toggleAccount' }>

/** Prepare an owner-only account action; no service mutation is dispatched here. */
export function createManagerManagedServiceAccountRoute(input: {
  readonly context: ManagerRendererChannelContext
  readonly owner: ManagedServiceUIOwner
  readonly ownerToken: string
  readonly requestId: string
  readonly scope: Record<string, unknown>
  readonly forwarded: Record<string, unknown>
  readonly parsed: Toggle
  readonly accounts: ManagerManagedServiceAccounts
  readonly runtime: {
    handleBindingValue(value: string, signal?: AbortSignal): Promise<Record<string, unknown>>
    prepareAccountToggle?(value: string): Promise<unknown>
  }
  readonly sanitize: (value: unknown, requestId: string) => Record<string, unknown>
  readonly assertCurrent: () => void
}) {
  const unavailable = (): never => {
    throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
  }
  const { parsed, context } = input
  const readAccounts = async () => {
    const readId = 'accounts-' + randomBytes(16).toString('hex')
    const read = {
      version: 1,
      token: input.ownerToken,
      requestId: readId,
      operation: 'readAccounts',
      scope: input.scope,
      serviceId: parsed.serviceId,
      binding: parsed.binding,
    }
    const response = input.sanitize(
      await input.runtime.handleBindingValue(JSON.stringify(read), context.signal),
      readId,
    )
    input.assertCurrent()
    if (response.ok !== true) return { status: 'unavailable' as const, code: 'owner-unavailable' as const }
    const projected = await input.accounts.project(response.value, parsed.binding)
    input.assertCurrent()
    if (projected.status === 'available') {
      const confirmationId = 'accounts-' + randomBytes(16).toString('hex')
      const confirmation = input.sanitize(
        await input.runtime.handleBindingValue(
          JSON.stringify({ ...read, requestId: confirmationId, operation: 'snapshot' }),
          context.signal,
        ),
        confirmationId,
      )
      const snapshot = confirmation.value as {
        status?: unknown
        projection?: { binding?: unknown; serviceGeneration?: unknown }
      }
      if (
        confirmation.ok !== true || !snapshot || snapshot.status !== 'available' || !snapshot.projection
        || !isDeepStrictEqual(snapshot.projection.binding, parsed.binding)
        || snapshot.projection.serviceGeneration !== projected.accounts.serviceGeneration
      ) return unavailable()
    }
    input.assertCurrent()
    return projected
  }
  const action = createManagerManagedServiceAccountToggle({
    identity: { ...input.owner, serviceId: parsed.serviceId },
    requestId: input.requestId,
    request: parsed.request,
    preparePlan: async () => {
      if (!input.runtime.prepareAccountToggle) return unavailable()
      const plan = await input.runtime.prepareAccountToggle(JSON.stringify(input.forwarded))
      input.assertCurrent()
      return plan
    },
    readAccounts,
    toggle: async () => {
      const response = input.sanitize(
        await input.runtime.handleBindingValue(JSON.stringify(input.forwarded), context.signal),
        input.requestId,
      )
      input.assertCurrent()
      if (response.ok !== true) return unavailable()
      return await input.accounts.toggle(response.value, parsed.request)
    },
  })
  return {
    mode: 'write' as const,
    managedServiceAccountToggle: action,
    async dispatch() {
      return { requestId: input.requestId, ok: false, code: 'unsupported' }
    },
  }
}
