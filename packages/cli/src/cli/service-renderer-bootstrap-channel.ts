import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'

/** The sidecar supplies graph mappings; this channel is never exposed to a plugin. */
export function createServiceRendererBootstrapChannel(input: {
  readonly profileId: string
  readonly generation: string
  readonly permissionProof: boolean
  readonly prepare: (rendererId: string) => Promise<unknown>
  readonly status: (context: ManagerRendererChannelContext) => Promise<unknown>
  readonly complete: (
    context: ManagerRendererChannelContext,
    origin: string,
    graphs: unknown,
    key?: unknown,
  ) => Promise<unknown>
}): ManagerRendererChannel {
  return {
    prepare: (payload, context) => {
      if (
        payload === null || typeof payload !== 'object' || Array.isArray(payload)
        || context.profileId !== input.profileId || context.ownerGeneration !== input.generation
      ) throw new Error('renderer-bootstrap-unavailable')
      const item = payload as Record<string, unknown>
      if (item.action === 'prepare' && Object.keys(item).length === 1) {
        return { mode: 'read', dispatch: async () => await input.prepare(context.rendererId) }
      }
      if (item.action === 'status' && Object.keys(item).length === 1) {
        return { mode: 'read', dispatch: async () => await input.status(context) }
      }
      if (
        item.action === 'complete' && Object.keys(item).length === (input.permissionProof ? 4 : 3)
        && typeof item.managerOrigin === 'string' && Array.isArray(item.graphs)
        && Object.keys(item).every(key => ['action', 'managerOrigin', 'graphs', 'permissionPublicKey'].includes(key))
        && (!input.permissionProof || Object.hasOwn(item, 'permissionPublicKey'))
      ) {
        return {
          mode: 'read',
          dispatch: async () =>
            await input.complete(context, item.managerOrigin as string, item.graphs, item.permissionPublicKey),
        }
      }
      throw new Error('renderer-bootstrap-unavailable')
    },
  }
}
