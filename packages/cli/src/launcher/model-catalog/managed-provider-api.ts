import { CatalogError, object } from './contracts.js'
import type { ManagedProviderOwner } from './managed-provider-owner.js'

/** Bind only to trusted Host management. Never mount on plugin RPC or a shared renderer global. */
export function createManagedProviderApi(input: {
  readonly owner: ManagedProviderOwner
  readonly generation: string
  readonly authorized: () => boolean
  readonly capture: (signal: AbortSignal) => Promise<string>
}) {
  let disposed = false
  const active = () => !disposed && input.authorized()
  const check = (request: unknown) => {
    const value = object(request)
    if (!active() || !value || value.generation !== input.generation) throw new CatalogError('permission')
    return value
  }
  return Object.freeze({
    read(request: unknown) {
      const value = check(request)
      if (Object.keys(value).length !== 1) throw new CatalogError('source-invalid')
      return input.owner.snapshot()
    },
    async save(request: unknown) {
      const value = check(request)
      if (
        Object.keys(value).some(key =>
          !['generation', 'id', 'expectedRevision', 'settings', 'replaceCredential'].includes(key)
        )
        || typeof value.replaceCredential !== 'boolean'
        || value.id !== undefined && typeof value.id !== 'string'
        || value.expectedRevision !== undefined && typeof value.expectedRevision !== 'string'
      ) throw new CatalogError('source-invalid')
      return input.owner.save(
        {
          ...(typeof value.id === 'string' ? { id: value.id } : {}),
          ...(typeof value.expectedRevision === 'string' ? { expectedRevision: value.expectedRevision } : {}),
          settings: value.settings,
        },
        value.replaceCredential
          ? async signal => {
            if (!active()) throw new CatalogError('permission')
            const secret = await input.capture(signal)
            if (!active()) throw new CatalogError('permission')
            return secret
          }
          : undefined,
        active,
      )
    },
    async remove(request: unknown) {
      const value = check(request)
      if (
        Object.keys(value).some(key => !['generation', 'id', 'expectedRevision'].includes(key))
        || typeof value.id !== 'string' || typeof value.expectedRevision !== 'string'
      ) throw new CatalogError('source-invalid')
      await input.owner.remove(value.id, value.expectedRevision, active)
    },
    dispose() {
      disposed = true
    },
  })
}
