import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EntityFile, EntityPromptFile, EntityTemplateDeclaration } from '@cordisx/protocol/entities/v1'

import {
  EntityDirectoryAuthority,
  entityTreeDigest,
  type EntityTemplatePayload,
} from '../packages/cli/src/launcher/entity-directory.js'
import { entityInstallationId } from '../packages/cli/src/launcher/owner-document-rpc.js'

const roots = new Set<string>()
afterEach(async () => { await Promise.all([...roots].map(async root => await rm(root, { recursive: true, force: true }))); roots.clear() })

const entity = (name: string): EntityFile => ({
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json',
  contract: 'cordisx.entity-file/v1', schemaVersion: 1, agentId: 'lead', name,
  inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
  promptSections: [{ sectionId: 'role', kind: 'role', source: { kind: 'markdown', path: './prompts/role.md' } }],
})

describe('Host profile entity directory', () => {
  it('materializes exact package bytes only when absent and recovers CAS state across restart', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-entities-')); roots.add(home)
    const entityText = `${JSON.stringify(entity('Lead'), null, 2)}\n`
    const promptFiles: readonly EntityPromptFile[] = [{ path: './prompts/role.md', text: 'Coordinate the room.\n' }]
    const declaration: EntityTemplateDeclaration = {
      agentId: 'lead', entityPath: './entities/lead/entity.json', digest: entityTreeDigest(entityText, promptFiles),
    }
    const template: EntityTemplatePayload = { declaration, entityText, promptFiles }
    const binding = { profileId: 'profile-a', installationId: entityInstallationId('profile-a', 'chatroom'), pluginId: 'chatroom', pluginGeneration: 1 }
    const authority = new EntityDirectoryAuthority(home, 'profile-a')
    authority.register(binding, [declaration])
    expect(await authority.materialize(binding, '1.0.0', `sha256:${'1'.repeat(64)}`, [template]))
      .toMatchObject([{ status: 'materialized', code: 'created', entity: { identity: { agentId: 'lead', revision: declaration.digest }, origin: 'materialized-template' } }])
    expect((await authority.snapshot(binding)).entities).toHaveLength(1)

    const current = (await authority.snapshot(binding)).entities[0]!
    const updated = await authority.save(binding, {
      mutationId: 'edit-lead', expectedRevision: current.digest,
      entity: entity('Lead locally edited'), promptFiles: [{ path: './prompts/role.md', text: 'Coordinate local work.\n' }],
    })
    expect(updated).toMatchObject({ status: 'applied', disposition: 'updated', entity: { origin: 'local', definition: { name: 'Lead locally edited' } } })
    expect(await authority.save(binding, {
      mutationId: 'edit-lead', expectedRevision: current.digest,
      entity: entity('Lead locally edited'), promptFiles: [{ path: './prompts/role.md', text: 'Coordinate local work.\n' }],
    })).toMatchObject({ status: 'applied', disposition: 'replayed' })

    expect(await authority.materialize(binding, '1.1.0', `sha256:${'2'.repeat(64)}`, [template]))
      .toEqual([expect.objectContaining({ status: 'preserved', code: 'entity-present' })])
    expect(await readFile(path.join(home, 'profiles/profile-a/entities/lead/entity.json'), 'utf8')).toContain('Lead locally edited')

    const restarted = new EntityDirectoryAuthority(home, 'profile-a')
    restarted.register({ ...binding, pluginGeneration: 2 }, [declaration])
    expect(await restarted.snapshot({ ...binding, pluginGeneration: 2 })).toMatchObject({
      binding: { pluginGeneration: 2 }, entities: [{ owner: { profileId: 'profile-a', pluginId: 'chatroom' }, definition: { name: 'Lead locally edited' }, origin: 'local' }],
    })
    await writeFile(path.join(home, 'profiles/profile-a/entities/lead/entity.json'), `${JSON.stringify(entity('Lead externally edited'), null, 2)}\n`)
    const watched = await restarted.snapshot({ ...binding, pluginGeneration: 2 })
    expect(watched).toMatchObject({ registryRevision: 2, entities: [{ definition: { name: 'Lead externally edited' } }] })
    expect(await restarted.changes({ ...binding, pluginGeneration: 2 }, 1, 1))
      .toMatchObject({ revision: 2, changes: [{ sequence: 2, kind: 'entity-updated', entity: { definition: { name: 'Lead externally edited' } } }] })
  })

  it('fails closed for undeclared writes and symlink-backed entity trees', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-entities-fence-')); roots.add(home)
    const authority = new EntityDirectoryAuthority(home, 'profile-a')
    const binding = { profileId: 'profile-a', installationId: entityInstallationId('profile-a', 'chatroom'), pluginId: 'chatroom', pluginGeneration: 1 }
    authority.register(binding, [])
    expect(await authority.save(binding, { mutationId: 'no-declaration', expectedRevision: null, entity: entity('Lead'), promptFiles: [{ path: './prompts/role.md', text: 'Role' }] }))
      .toEqual({ status: 'rejected', code: 'entity-not-declared' })

    await mkdir(path.join(home, 'profiles/profile-a/entities'), { recursive: true })
    await writeFile(path.join(home, 'outside.json'), '{}')
    // The authority never follows a hostile existing target and does not claim ownership.
    await expect(import('node:fs/promises').then(async fs => await fs.symlink(path.join(home, 'outside.json'), path.join(home, 'profiles/profile-a/entities/lead')))).resolves.toBeUndefined()
    const source = `${JSON.stringify(entity('Lead'), null, 2)}\n`
    const prompts = [{ path: './prompts/role.md' as const, text: 'Role' }]
    const declaration = { agentId: 'lead', entityPath: './entities/lead/entity.json' as const, digest: entityTreeDigest(source, prompts) }
    authority.register(binding, [declaration])
    expect(await authority.materialize(binding, '1.0.0', `sha256:${'3'.repeat(64)}`, [{ declaration, entityText: source, promptFiles: prompts }]))
      .toEqual([expect.objectContaining({ status: 'rejected', code: 'symlink-escape' })])
  })

  it('claims but never overwrites an existing declared local entity', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-entities-existing-')); roots.add(home)
    const localText = `${JSON.stringify(entity('User local Lead'), null, 2)}\n`
    const prompts = [{ path: './prompts/role.md' as const, text: 'User-owned local prompt.\n' }]
    await mkdir(path.join(home, 'profiles/profile-a/entities/lead/prompts'), { recursive: true })
    await writeFile(path.join(home, 'profiles/profile-a/entities/lead/entity.json'), localText)
    await writeFile(path.join(home, 'profiles/profile-a/entities/lead/prompts/role.md'), prompts[0].text)
    const templateText = `${JSON.stringify(entity('Package Lead'), null, 2)}\n`
    const declaration = { agentId: 'lead', entityPath: './entities/lead/entity.json' as const, digest: entityTreeDigest(templateText, prompts) }
    const binding = { profileId: 'profile-a', installationId: entityInstallationId('profile-a', 'chatroom'), pluginId: 'chatroom', pluginGeneration: 1 }
    const authority = new EntityDirectoryAuthority(home, 'profile-a'); authority.register(binding, [declaration])
    expect(await authority.materialize(binding, '1.0.0', `sha256:${'5'.repeat(64)}`, [{ declaration, entityText: templateText, promptFiles: prompts }]))
      .toEqual([expect.objectContaining({ status: 'preserved', code: 'entity-present' })])
    expect(await readFile(path.join(home, 'profiles/profile-a/entities/lead/entity.json'), 'utf8')).toBe(localText)
    expect(await authority.snapshot(binding)).toMatchObject({ entities: [{ definition: { name: 'User local Lead' }, origin: 'local' }] })
  })
})
