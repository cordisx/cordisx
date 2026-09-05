import { randomUUID } from 'node:crypto'

import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'
import type { EntityRegistryBinding, EntitySaveRequest, EntitySubscriptionClosed } from '@cordisx/protocol/entities/v1'

import { EntityDirectoryAuthority, type EntityDirectoryBinding } from './entity-directory.js'
import {
  entityInstallationId,
  entityPluginGeneration,
  issueOwnerDocumentPrincipalToken,
  type OwnerDocumentPrincipal,
  verifyOwnerDocumentPrincipalToken,
} from './owner-document-rpc.js'

export const ENTITY_OPERATIONS = new Set([
  'entity-snapshot',
  'entity-get',
  'entity-save',
  'entity-subscribe',
  'entity-read',
  'entity-unsubscribe',
])

interface EntityRequest {
  readonly version: 1
  readonly requestId: string
  readonly token: string
  readonly operation: string
  readonly binding?: EntityRegistryBinding
  readonly identity?: AgentDefinitionIdentity
  readonly request?: EntitySaveRequest
  readonly afterRevision?: number
  readonly replayThrough?: number
  readonly subscriptionId?: string
}

interface SubscriptionRecord {
  readonly principalKey: string
  readonly binding: EntityDirectoryBinding
  readonly replayThrough: number
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('entity request must be an object')
  }
  return value as Record<string, unknown>
}

export function isEntityBindingRequest(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && ENTITY_OPERATIONS.has(String((value as { readonly operation?: unknown }).operation))
}

export interface EntityBridgePrincipalBinding {
  readonly source: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly installationId: string
  readonly pluginGeneration: number
  readonly token: string
}

export interface EntityBridgeHandler {
  issue(
    identity: { readonly source: string; readonly pluginId: string },
    moduleGeneration: string,
  ): EntityBridgePrincipalBinding
  handle(value: unknown): Promise<unknown>
}

export function createEntityBridgeHandler(input: {
  readonly secret: string
  readonly profileId: string
  readonly generation: string
  readonly authority: EntityDirectoryAuthority
  readonly principalAllowed: (principal: OwnerDocumentPrincipal) => boolean
}): EntityBridgeHandler {
  const subscriptions = new Map<string, SubscriptionRecord>()
  const resolve = (
    request: EntityRequest,
  ): { readonly principal: OwnerDocumentPrincipal; readonly binding: EntityDirectoryBinding } => {
    const principal = verifyOwnerDocumentPrincipalToken(input.secret, request.token)
    const binding = request.binding
    if (
      principal === undefined || binding === undefined || principal.profileId !== input.profileId
      || principal.generation !== input.generation
      || !input.principalAllowed(principal) || binding.profileId !== principal.profileId
      || binding.pluginId !== principal.identity.pluginId
      || binding.installationId !== entityInstallationId(principal.profileId, principal.identity.pluginId)
      || binding.pluginGeneration !== entityPluginGeneration(principal.moduleGeneration)
    ) throw new Error('entity principal is stale')
    return { principal, binding }
  }
  return {
    issue(identity, moduleGeneration) {
      const principal = { profileId: input.profileId, generation: input.generation, moduleGeneration, identity }
      return {
        ...identity,
        moduleGeneration,
        installationId: entityInstallationId(input.profileId, identity.pluginId),
        pluginGeneration: entityPluginGeneration(moduleGeneration),
        token: issueOwnerDocumentPrincipalToken(input.secret, principal),
      }
    },
    async handle(value) {
      const raw = object(value)
      const request = raw as unknown as EntityRequest
      if (
        request.version !== 1 || typeof request.requestId !== 'string' || typeof request.token !== 'string'
        || !ENTITY_OPERATIONS.has(request.operation)
      ) throw new Error('entity request envelope is invalid')
      if (request.operation === 'entity-unsubscribe') {
        if (typeof request.subscriptionId !== 'string') throw new Error('entity subscription id is invalid')
        const subscription = subscriptions.get(request.subscriptionId)
        const principal = verifyOwnerDocumentPrincipalToken(input.secret, request.token)
        if (
          subscription === undefined || principal === undefined || !input.principalAllowed(principal)
          || subscription.principalKey
            !== JSON.stringify([principal.identity.source, principal.identity.pluginId, principal.moduleGeneration])
        ) throw new Error('entity subscription is stale')
        subscriptions.delete(request.subscriptionId)
        return { status: 'closed', code: 'unsubscribed' }
      }
      if (request.operation === 'entity-read') {
        if (
          typeof request.subscriptionId !== 'string' || !Number.isSafeInteger(request.afterRevision)
          || !Number.isSafeInteger(request.replayThrough)
        ) throw new Error('entity read cursor is invalid')
        const subscription = subscriptions.get(request.subscriptionId)
        const principal = verifyOwnerDocumentPrincipalToken(input.secret, request.token)
        if (
          subscription === undefined || principal === undefined || !input.principalAllowed(principal)
          || subscription.principalKey
            !== JSON.stringify([principal.identity.source, principal.identity.pluginId, principal.moduleGeneration])
        ) throw new Error('entity subscription is stale')
        return await input.authority.changes(subscription.binding, request.afterRevision!, subscription.replayThrough)
      }
      const { principal, binding } = resolve(request)
      if (request.operation === 'entity-snapshot') return await input.authority.snapshot(binding)
      if (request.operation === 'entity-get') {
        if (request.identity === undefined) throw new Error('entity identity is required')
        const entity = await input.authority.get(binding, request.identity)
        return entity === undefined ? { status: 'not-found' } : { status: 'found', entity }
      }
      if (request.operation === 'entity-save') {
        if (request.request === undefined) throw new Error('entity save request is required')
        return await input.authority.save(binding, structuredClone(request.request))
      }
      if (request.operation === 'entity-subscribe') {
        if (!Number.isSafeInteger(request.afterRevision) || request.afterRevision! < 0) {
          throw new Error('entity subscription cursor is invalid')
        }
        const snapshot = await input.authority.snapshot(binding)
        const subscriptionId = `cx-entity-subscription.${randomUUID()}`
        subscriptions.set(subscriptionId, {
          principalKey: JSON.stringify([
            principal.identity.source,
            principal.identity.pluginId,
            principal.moduleGeneration,
          ]),
          binding,
          replayThrough: snapshot.registryRevision,
        })
        return {
          subscriptionId,
          binding: structuredClone(binding),
          afterRevision: request.afterRevision!,
          replayThrough: snapshot.registryRevision,
        }
      }
      throw new Error('entity operation is unsupported')
    },
  }
}

export function entityBridgeUnavailable(
  binding: EntityRegistryBinding,
  subscriptionId: string,
): EntitySubscriptionClosed {
  return {
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-registry-subscription-close.v1.schema.json',
    contract: 'cordisx.entity-registry-subscription-close/v1',
    schemaVersion: 1,
    subscriptionId,
    binding,
    status: 'closed',
    code: 'connection-replaced',
  }
}
