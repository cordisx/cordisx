import { pathToFileURL } from 'node:url'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import {
  ownerDocumentBridgeError,
  parseOwnerDocumentBindingRequest,
  verifyOwnerDocumentPrincipalToken,
} from '../launcher/owner-document-rpc.js'
import { OwnerDocumentStore } from '../launcher/owner-document-store.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { OwnerAdapterDocumentContext } from './owner-adapter-sessions.js'

/** The service owns durable documents; native sessions supply only an owner-issued principal. */
export function createOwnerAdapterDocuments(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly configured: readonly CordisXConfigPlugin[]
  readonly snapshot: () => Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }>
  readonly store?: OwnerDocumentStore
}) {
  const store = input.store ?? new OwnerDocumentStore(input.homeDir)
  const configured = new Map(
    input.configured.filter(plugin => plugin.enabled).map(plugin => [
      plugin.id,
      plugin.source ?? pathToFileURL(plugin.entry).href,
    ]),
  )
  return async (value: unknown, context: OwnerAdapterDocumentContext): Promise<unknown> => {
    const request = parseOwnerDocumentBindingRequest(value)
    const write = request.operation === 'replace'
    const principal = verifyOwnerDocumentPrincipalToken(context.secret, request.token)
    if (
      !context.current(write) || !principal || principal.profileId !== input.profileId
      || principal.generation !== input.generation
    ) return ownerDocumentBridgeError()
    let snapshot: ReturnType<typeof input.snapshot>
    try {
      snapshot = structuredClone(input.snapshot())
    } catch {
      return ownerDocumentBridgeError()
    }
    const current = () => {
      try {
        return context.current(write) && attachmentEqual(input.snapshot(), snapshot)
      } catch {
        return false
      }
    }
    const identity = principal.identity
    if (configured.get(identity.pluginId) !== identity.source) {
      const plugin = snapshot.active.plugins.find(item => item.id === identity.pluginId && item.enabled)
      if (!plugin || plugin.moduleGeneration !== principal.moduleGeneration) return ownerDocumentBridgeError()
      const staged = await loadStagedPluginPackage(input.homeDir, plugin.digest).catch(() => undefined)
      if (
        !staged || staged.identitySource !== identity.source || staged.manifest.id !== plugin.id
        || staged.manifest.version !== plugin.version
        || !attachmentEqual(staged.manifest.dependencies, plugin.dependencies)
      ) return ownerDocumentBridgeError()
    }
    if (!current()) return ownerDocumentBridgeError()
    const scope = { profileId: input.profileId, identity }
    if (request.operation === 'load') {
      const result = await store.load(scope, request.documentId)
      return current() ? result : ownerDocumentBridgeError()
    }
    return await store.replace({
      scope,
      documentId: request.documentId,
      expectedRevision: request.expectedRevision!,
      schemaVersion: request.schemaVersion!,
      value: request.value,
      commitAllowed: current,
    })
  }
}
