import { randomBytes } from 'node:crypto'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import {
  type OwnerDocumentBindingRequest,
  ownerDocumentBridgeError,
  type OwnerDocumentPrincipalBinding,
  parseOwnerDocumentBindingRequest,
} from '../launcher/owner-document-rpc.js'
import { OwnerDocumentStore } from '../launcher/owner-document-store.js'
import type { PluginRuntimeMutation } from '../launcher/plugin-lifecycle-model.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { ServiceRendererBootstrapEntry, ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'
import { MANAGER_DOCUMENT_REQUEST_BYTES } from '../independent-manager/owner-document-limits.js'

type Grant = {
  readonly token: string
  readonly alias: string
  readonly source: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly entry: ServiceRendererBootstrapEntry
}

/** Owner-only mapping from one renderer's opaque plugin identity to durable documents. */
export class ServiceRendererDocuments {
  private readonly store: OwnerDocumentStore
  private readonly grants = new WeakMap<AbortSignal, Map<string, Grant>>()

  constructor(
    private readonly input: {
      readonly homeDir: string
      readonly profileId: string
      readonly generation: string
      readonly entries: Map<string, ServiceRendererBootstrapEntry>
      readonly current: (rendererId: string, entry: ServiceRendererBootstrapEntry) => boolean
      readonly snapshot: () => ServiceRendererSnapshot
    },
  ) {
    this.store = new OwnerDocumentStore(input.homeDir)
  }

  private entry(context: ManagerRendererChannelContext): ServiceRendererBootstrapEntry | undefined {
    const entry = this.input.entries.get(context.rendererId)
    return entry && !context.signal.aborted && context.profileId === this.input.profileId
        && context.ownerGeneration === this.input.generation && entry.identityContext?.signal === context.signal
        && this.input.current(context.rendererId, entry)
      ? entry
      : undefined
  }

  private issue(
    context: ManagerRendererChannelContext,
    entry: ServiceRendererBootstrapEntry,
    alias: string,
    pluginId: string,
    moduleGeneration: string,
  ): OwnerDocumentPrincipalBinding {
    if (this.entry(context) !== entry || !entry.identity) throw new Error('renderer-documents-unavailable')
    const source = entry.identity.resolveLifecycle(context, alias, pluginId).source
    let grants = this.grants.get(context.signal)
    if (!grants) {
      grants = new Map()
      this.grants.set(context.signal, grants)
      context.signal.addEventListener('abort', () => grants!.clear(), { once: true })
    }
    const prior = [...grants.values()].find(grant =>
      grant.entry === entry && grant.alias === alias && grant.source === source && grant.pluginId === pluginId
      && grant.moduleGeneration === moduleGeneration
    )
    if (prior) return { source: alias, pluginId, moduleGeneration, token: prior.token }
    if (grants.size >= 1024) throw new Error('renderer-documents-unavailable')
    const token = randomBytes(32).toString('hex')
    grants.set(token, { token, alias, source, pluginId, moduleGeneration, entry })
    return { source: alias, pluginId, moduleGeneration, token }
  }

  initial(
    context: ManagerRendererChannelContext,
    entry: ServiceRendererBootstrapEntry,
  ): OwnerDocumentPrincipalBinding[] {
    if (!entry.snapshot || !entry.identity || !entry.identityAliases) throw new Error('renderer-documents-unavailable')
    return entry.snapshot.active.plugins.flatMap(item => {
      const alias = entry.identityAliases!.get(item.id)
      if (!item.enabled || entry.unavailableInstalledPlugins?.has(item.id)) return []
      if (!alias) throw new Error('renderer-documents-unavailable')
      return [this.issue(context, entry, alias, item.id, item.moduleGeneration)]
    })
  }

  candidate(
    context: ManagerRendererChannelContext,
    entry: ServiceRendererBootstrapEntry,
    mutation: PluginRuntimeMutation,
  ): OwnerDocumentPrincipalBinding[] {
    if (
      !entry.identity || !entry.pendingIdentity || entry.pendingIdentity.transactionId !== mutation.transactionId
      || !attachmentEqual(entry.pendingIdentity.candidate, mutation.candidate)
      || !entry.lifecycleTransition?.isCurrent()
    ) throw new Error('renderer-documents-unavailable')
    return mutation.affectedPluginIds.flatMap(id => {
      const item = mutation.candidate.plugins.find(plugin => plugin.id === id)
      if (!item?.enabled) return []
      const alias = entry.identity!.candidateAlias(context, mutation.transactionId, id)
      return [this.issue(context, entry, alias, id, item.moduleGeneration)]
    })
  }

  private allowed(context: ManagerRendererChannelContext, grant: Grant, write: boolean): boolean {
    try {
      const entry = this.entry(context)
      if (
        !entry || entry !== grant.entry || write && !context.admitted || !entry.bootstrapConfirmed || !entry.snapshot
        || !entry.identity || entry.lifecycleTransition || entry.channelTransition
        || !attachmentEqual(this.input.snapshot(), entry.snapshot)
      ) return false
      const plugin = entry.snapshot.active.plugins.find(item => item.id === grant.pluginId)
      if (!plugin?.enabled || plugin.moduleGeneration !== grant.moduleGeneration) return false
      return entry.identity.currentAlias(context, grant.pluginId) === grant.alias
        && entry.identity.resolveLifecycle(context, grant.alias, grant.pluginId).source === grant.source
    } catch {
      return false
    }
  }

  /** Resolve only a live, generation-bound Host principal for another owner capability. */
  principal(context: ManagerRendererChannelContext, token: string, options: { readonly initialRead?: true } = {}) {
    const grant = this.grants.get(context.signal)?.get(token)
    if (!grant) throw new Error('renderer-principal-unavailable')
    const entry = this.entry(context)
    const pending = entry?.pendingIdentity
    const item = pending?.candidate.plugins.find(plugin => plugin.id === grant.pluginId)
    const candidateCurrent = () => {
      try {
        const next = this.entry(context)
        if (
          !context.admitted || !entry || next !== entry || grant.entry !== entry || !pending || !item?.enabled
          || entry.pendingIdentity !== pending || !entry.lifecycleTransition?.isCurrent() || !entry.snapshot
          || !entry.identity || entry.channelTransition || !attachmentEqual(entry.snapshot.active, pending.previous)
          || item.moduleGeneration !== grant.moduleGeneration
          || entry.identity.candidateAlias(context, pending.transactionId, grant.pluginId) !== grant.alias
        ) return false
        const resolved = entry.identity.resolveLifecycle(context, grant.alias, grant.pluginId)
        return resolved.source === grant.source && resolved.digest === item.digest
      } catch {
        return false
      }
    }
    if (candidateCurrent()) {
      return {
        kind: 'candidate' as const,
        identity: { id: grant.pluginId, source: grant.alias },
        ownerIdentity: { id: grant.pluginId, source: grant.source },
        moduleGeneration: grant.moduleGeneration,
        transactionId: pending!.transactionId,
        digest: item!.digest,
        version: item!.version,
        isCurrent: candidateCurrent,
      }
    }
    const initialRead = options.initialRead === true && context.admitted !== true
    const current = () => {
      const entry = this.entry(context)
      return !!grant && this.allowed(context, grant, !initialRead)
        && (!initialRead || !!entry?.releasePermissionFence && !entry.pendingIdentity)
    }
    if (!grant || !current()) throw new Error('renderer-principal-unavailable')
    return {
      kind: 'active' as const,
      identity: { id: grant.pluginId, source: grant.alias },
      ownerIdentity: { id: grant.pluginId, source: grant.source },
      moduleGeneration: grant.moduleGeneration,
      isCurrent: current,
    }
  }

  channel(): ManagerRendererChannel {
    return {
      prepare: (payload, context) => {
        if (typeof payload !== 'string' || Buffer.byteLength(payload) > MANAGER_DOCUMENT_REQUEST_BYTES) {
          throw new Error('renderer-documents-unavailable')
        }
        const request: OwnerDocumentBindingRequest = parseOwnerDocumentBindingRequest(JSON.parse(payload))
        const grant = this.grants.get(context.signal)?.get(request.token)
        const current = () => !!grant && this.allowed(context, grant, request.operation === 'replace')
        if (!current()) {
          return {
            mode: 'read',
            dispatch: async () => ({ requestId: request.requestId, ok: true, value: ownerDocumentBridgeError() }),
          }
        }
        return {
          mode: request.operation === 'load' ? 'read' : 'write',
          channelConfigurationIndependent: true,
          dispatch: async () => {
            if (!current()) return { requestId: request.requestId, ok: true, value: ownerDocumentBridgeError() }
            const scope = {
              profileId: context.profileId,
              identity: { pluginId: grant!.pluginId, source: grant!.source },
            }
            const value = request.operation === 'load'
              ? await this.store.load(scope, request.documentId)
              : await this.store.replace({
                scope,
                documentId: request.documentId,
                expectedRevision: request.expectedRevision!,
                schemaVersion: request.schemaVersion!,
                value: request.value,
                commitAllowed: current,
              })
            // An accepted replacement may already be durable when the renderer
            // retires; never turn that receipt into a definite failure.
            return {
              requestId: request.requestId,
              ok: true,
              value: request.operation === 'replace' && value.status === 'accepted' || current()
                ? value
                : ownerDocumentBridgeError(),
            }
          },
        }
      },
    }
  }
}
