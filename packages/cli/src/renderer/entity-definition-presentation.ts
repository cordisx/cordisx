import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'
import type { EntityRegistrySnapshot } from '@cordisx/protocol/entities/v1'
import { resolveAgentDefinitionCatalog } from './agent-loop.js'
import { type CordisXAgentDefinitionPresentation, presentationForDefinition } from './agent-loop-v4.js'

/** Read-only display of an authenticated exact Entity snapshot; never Session or execution authority. */
export function entityDefinitionPresentation(
  snapshot: EntityRegistrySnapshot | undefined,
  identity: AgentDefinitionIdentity,
): CordisXAgentDefinitionPresentation | undefined {
  if (snapshot === undefined) return undefined
  const binding = snapshot.binding
  const owned = snapshot.entities.filter(entity =>
    entity.access === 'owned'
    && entity.owner.profileId === binding.profileId && entity.owner.pluginId === binding.pluginId
    && entity.owner.installationId === binding.installationId && entity.digest === entity.identity.revision
    && entity.definition.identity.agentId === entity.identity.agentId
    && entity.definition.identity.revision === entity.identity.revision
  )
  const target = owned.find(entity =>
    entity.identity.agentId === identity.agentId && entity.identity.revision === identity.revision
  )
  if (target === undefined) return undefined
  try {
    const seen = new Set<string>()
    const definitions: typeof target.definition[] = []
    const visit = (current: typeof target): void => {
      const key = JSON.stringify(current.identity)
      if (seen.has(key)) return
      seen.add(key)
      if (definitions.length >= 64) throw new Error('Entity definition closure exceeds its bound')
      definitions.push(current.definition)
      for (const parent of current.definition.extends ?? []) {
        const matches = owned.filter(entity =>
          entity.identity.agentId === parent.agentId && entity.identity.revision === parent.revision
        )
        if (matches.length !== 1) throw new Error('Entity definition parent is unavailable or ambiguous')
        visit(matches[0]!)
      }
    }
    visit(target)
    return presentationForDefinition(
      resolveAgentDefinitionCatalog({ definition: identity, definitions: [target.definition, ...definitions.slice(1)] })
        .target,
    )
  } catch {
    return undefined
  }
}

/** One display lookup order for the production Shell; Entity views are always owner scoped. */
export function createEntityAwareIdentityResolver(input: {
  readonly session: (identity: AgentDefinitionIdentity) => CordisXAgentDefinitionPresentation | undefined
  readonly agentLoop: (identity: AgentDefinitionIdentity) => CordisXAgentDefinitionPresentation | undefined
  readonly entitySnapshot: (ownerId: string) => EntityRegistrySnapshot | undefined
}): (identity: AgentDefinitionIdentity, ownerId?: string) => CordisXAgentDefinitionPresentation | undefined {
  return (identity, ownerId) =>
    input.session(identity) ?? input.agentLoop(identity)
      ?? entityDefinitionPresentation(ownerId === undefined ? undefined : input.entitySnapshot(ownerId), identity)
}
