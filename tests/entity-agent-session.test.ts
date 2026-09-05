import { describe, expect, it } from 'vitest'
import type { AgentCancelCause } from '@cordisx/protocol/agents/v1'
import type { EntityRecord, EntityRegistry } from '@cordisx/protocol/entities/v1'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'

import {
  CordisXAgentSessionRuntime,
  type CordisXPersistedSession,
  type CordisXPrivateAgentDriver,
  type CordisXSessionEventPersistence,
} from '../packages/cli/src/renderer/agent-session-runtime.js'

class Driver implements CordisXPrivateAgentDriver {
  async create(): Promise<{ readonly status: 'accepted' }> {
    return { status: 'accepted' }
  }
  async resume(): Promise<{ readonly status: 'accepted' }> {
    return { status: 'accepted' }
  }
  async submit(_input: { readonly message: UserMessage }): Promise<'accepted'> {
    return 'accepted'
  }
  async discard(): Promise<'accepted'> {
    return 'accepted'
  }
  async cancel(_input: { readonly cause: AgentCancelCause; readonly keepInbox: boolean }): Promise<'accepted'> {
    return 'accepted'
  }
  onReplacement(): () => void {
    return () => undefined
  }
  dispose(): void {}
}

const digest = `sha256:${'a'.repeat(64)}` as const
const entity: EntityRecord = {
  identity: { agentId: 'lead', revision: digest },
  digest,
  definition: {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: 'lead', revision: digest },
    name: 'Lead persisted',
    inherit: {
      promptSections: 'none',
      rules: 'none',
      skills: 'none',
      tools: 'none',
      mcpServers: 'none',
      runtimeDefaults: 'none',
    },
    promptSections: [{ sectionId: 'role', kind: 'role', text: 'Coordinate.' }],
  },
  owner: { profileId: 'profile-a', installationId: 'cx-installation.test', pluginId: 'chatroom' },
  access: 'owned',
  origin: 'local',
}

describe('entity-backed Agent/Session acquisition', () => {
  it('binds create to current exact entity and resumes only from the persisted Session event', async () => {
    let current: EntityRecord | undefined = entity
    const registry = {
      binding: { ...entity.owner, pluginGeneration: 1 },
      snapshot: async () => ({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-registry-snapshot.v1.schema.json',
        contract: 'cordisx.entity-registry-snapshot/v1',
        schemaVersion: 1,
        binding: { ...entity.owner, pluginGeneration: 1 },
        registryRevision: 1,
        entities: current === undefined ? [] : [current],
      }),
      get: async (identity: typeof entity.identity) =>
        current !== undefined && current.identity.agentId === identity.agentId
          && current.identity.revision === identity.revision
          ? { status: 'found' as const, entity: current }
          : { status: 'not-found' as const },
      save: async () => ({ status: 'rejected' as const, code: 'entity-not-declared' as const }),
      subscribe: async () => ({ status: 'unavailable' as const, code: 'host-unavailable' as const }),
    } as unknown as EntityRegistry
    let persisted!: CordisXPersistedSession
    const persistence: CordisXSessionEventPersistence = {
      create: async value => {
        persisted = structuredClone(value)
      },
      append: async input => {
        persisted = { ...persisted, events: [...persisted.events, ...structuredClone(input.events)] }
      },
      updateSetup: async input => {
        persisted = { ...persisted, setup: structuredClone(input.setup) }
      },
    }
    const owner = { pluginId: 'file:///chatroom.ts:chatroom', generation: 1 }
    const runtime = new CordisXAgentSessionRuntime({
      driver: new Driver(),
      authorize: async () => true,
      persistence,
      now: () => 42,
    })
    const createdOptions = {
      sessionId: 'cx-session.entity-one',
      mutationId: 'create-entity-one',
      definition: entity.identity,
    }
    const created = await runtime.createEntity(owner, createdOptions, registry)
    expect(created).toMatchObject({
      status: 'accepted',
      definitionSource: 'registry-current',
      definitionResolution: { identity: entity.identity },
    })
    if (created.status !== 'accepted') throw new Error('entity create unavailable')
    expect(Object.keys(created.definitionResolution).sort()).toEqual(['definition', 'digest', 'identity'])
    expect(persisted.events[0]).toMatchObject({
      seq: 0,
      type: 'entity/definition-bound',
      ignorable: true,
      data: { resolution: { identity: entity.identity, definition: { name: 'Lead persisted' } } },
    })
    current = undefined
    expect(await runtime.createEntity(owner, createdOptions, registry)).toMatchObject({
      status: 'accepted',
      disposition: 'replayed',
      definitionResolution: { identity: entity.identity },
    })
    await created.handle.dispose()
    expect(await runtime.resumeEntity(owner, { sessionId: created.sessionId, definitionSource: 'session-persisted' }))
      .toMatchObject({
        status: 'accepted',
        definitionSource: 'session-persisted',
        definitionResolution: { identity: entity.identity, definition: { name: 'Lead persisted' } },
      })
    await runtime.dispose()

    const recovered = new CordisXAgentSessionRuntime({
      driver: new Driver(),
      authorize: async () => true,
      initialSessions: [persisted],
    })
    expect(
      await recovered.resumeEntity(owner, {
        sessionId: persisted.id,
        definitionSource: 'session-persisted',
        definition: entity.identity,
      }),
    )
      .toMatchObject({ status: 'accepted', definitionSource: 'session-persisted' })
    expect(
      await recovered.resumeEntity(owner, {
        sessionId: persisted.id,
        definitionSource: 'session-persisted',
        definition: { agentId: 'lead', revision: 'new-local-revision' },
      }),
    )
      .toMatchObject({ status: 'unavailable', code: 'entity-revision-stale' })
    await recovered.dispose()
  })
})
