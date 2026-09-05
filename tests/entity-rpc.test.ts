import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { EntityDirectoryAuthority, entityTreeDigest } from '../packages/cli/src/launcher/entity-directory.js'
import { createEntityBridgeHandler } from '../packages/cli/src/launcher/entity-rpc.js'
import { entityInstallationId } from '../packages/cli/src/launcher/owner-document-rpc.js'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all([...roots].map(async root => await rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('entity registry Host bridge', () => {
  it('binds one installation/generation and keeps one atomic replay watermark', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-entity-rpc-'))
    roots.add(home)
    const profileId = 'profile-a'
    const pluginId = 'chatroom'
    const installationId = entityInstallationId(profileId, pluginId)
    const binding = { profileId, installationId, pluginId, pluginGeneration: 1 }
    const entity = (name: string) => ({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json' as const,
      contract: 'cordisx.entity-file/v1' as const,
      schemaVersion: 1 as const,
      agentId: 'lead',
      name,
      inherit: {
        promptSections: 'none' as const,
        rules: 'none' as const,
        skills: 'none' as const,
        tools: 'none' as const,
        mcpServers: 'none' as const,
        runtimeDefaults: 'none' as const,
      },
    })
    const entityText = `${JSON.stringify(entity('Lead'), null, 2)}\n`
    const declaration = {
      agentId: 'lead',
      entityPath: './entities/lead/entity.json' as const,
      digest: entityTreeDigest(entityText, []),
    }
    const authority = new EntityDirectoryAuthority(home, profileId)
    authority.register(binding, [declaration])
    await authority.materialize(binding, '1.0.0', `sha256:${'4'.repeat(64)}`, [{
      declaration,
      entityText,
      promptFiles: [],
    }])
    let live = true
    const bridge = createEntityBridgeHandler({
      secret: 'secret',
      profileId,
      generation: 'runtime-one',
      authority,
      principalAllowed: () => live,
    })
    const principal = bridge.issue({ source: 'file:///chatroom.js', pluginId }, 'module-one')
    const exactBinding = { ...binding, pluginGeneration: principal.pluginGeneration }
    let sequence = 0
    const call = async (operation: string, value: Record<string, unknown> = {}) =>
      await bridge.handle({
        version: 1,
        requestId: `request-${++sequence}`,
        token: principal.token,
        operation,
        binding: exactBinding,
        ...value,
      })
    const snapshot = await call('entity-snapshot') as {
      registryRevision: number
      entities: readonly { digest: `sha256:${string}` }[]
    }
    expect(snapshot).toMatchObject({
      binding: exactBinding,
      registryRevision: 1,
      entities: [{ definition: { name: 'Lead' } }],
    })
    const descriptor = await call('entity-subscribe', { afterRevision: 0 }) as {
      subscriptionId: string
      replayThrough: number
    }
    expect(descriptor.replayThrough).toBe(1)
    await call('entity-save', {
      request: {
        mutationId: 'update',
        expectedRevision: snapshot.entities[0]!.digest,
        entity: entity('Lead v2'),
        promptFiles: [],
      },
    })
    expect(
      await call('entity-read', {
        subscriptionId: descriptor.subscriptionId,
        afterRevision: 0,
        replayThrough: descriptor.replayThrough,
      }),
    )
      .toMatchObject({ revision: 2, changes: [{ sequence: 1, kind: 'entity-added' }] })
    expect(
      await call('entity-read', {
        subscriptionId: descriptor.subscriptionId,
        afterRevision: 1,
        replayThrough: descriptor.replayThrough,
      }),
    )
      .toMatchObject({ revision: 2, changes: [{ sequence: 2, kind: 'entity-updated' }] })
    await expect(
      bridge.handle({
        version: 1,
        requestId: 'wrong-installation',
        token: principal.token,
        operation: 'entity-snapshot',
        binding: { ...binding, installationId: 'cx-installation.wrong' },
      }),
    ).rejects.toThrow('stale')
    await expect(
      bridge.handle({
        version: 1,
        requestId: 'wrong-generation',
        token: principal.token,
        operation: 'entity-snapshot',
        binding: { ...exactBinding, pluginGeneration: exactBinding.pluginGeneration + 1 },
      }),
    ).rejects.toThrow('stale')
    live = false
    await expect(call('entity-snapshot')).rejects.toThrow('stale')
  })
})
