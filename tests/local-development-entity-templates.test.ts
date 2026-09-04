import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildLocalDevelopmentPlugin } from '../packages/cli/src/launcher/development.js'
import { entityTreeDigest } from '../packages/cli/src/launcher/entity-directory.js'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'

const PACKAGE_SCHEMA_V5 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v5.schema.json'
const PACKAGE_SCHEMA_V6 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v6.schema.json'
const ENTITY_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json'
const RUNTIME_SCHEMA_V5 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v5.schema.json'
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map(async root => await rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function fixture(): Promise<{
  readonly root: string
  readonly entry: string
  readonly configPath: string
  readonly entityPath: string
  readonly promptPath: string
  readonly writeManifest: (digest: `sha256:${string}`, version?: 4 | 5 | 6) => Promise<void>
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-entity-template-'))
  roots.add(root)
  const entry = path.join(root, 'src/chatroom.ts')
  const entityPath = path.join(root, 'entities/lead/entity.json')
  const promptPath = path.join(root, 'entities/lead/prompts/role.md')
  const configPath = path.join(root, 'cordisx.config.json')
  await mkdir(path.dirname(entry), { recursive: true })
  await mkdir(path.dirname(promptPath), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'chatroom-fixture', version: '1.0.0' }))
  await writeFile(entry, `
export const manifest = {
  $schema: '${RUNTIME_SCHEMA_V5}', schemaVersion: 5, id: 'chatroom', capabilities: [], services: [],
}
export function apply() {}
`)
  await writeFile(entityPath, `${JSON.stringify({
    $schema: ENTITY_SCHEMA_V1,
    contract: 'cordisx.entity-file/v1', schemaVersion: 1, agentId: 'lead', name: 'Lead',
    inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
    promptSections: [{ sectionId: 'role', kind: 'role', source: { kind: 'markdown', path: './prompts/role.md' } }],
  }, null, 2)}\n`)
  await writeFile(promptPath, 'Lead role from package.\n')
  await writeFile(configPath, JSON.stringify({
    version: 1, providers: [], plugins: [{ id: 'chatroom', entry: './src/chatroom.ts', enabled: true, config: {} }],
  }))
  const writeManifest = async (digest: `sha256:${string}`, version: 4 | 5 | 6 = 5): Promise<void> => {
    await writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify({
      $schema: version === 6 ? PACKAGE_SCHEMA_V6 : version === 5 ? PACKAGE_SCHEMA_V5 : 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v4.schema.json',
      schemaVersion: version,
      id: 'chatroom', version: '1.0.0', entry: './src/chatroom.ts',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      compatibility: { runtimeAbi: 1, protocolSchemas: [RUNTIME_SCHEMA_V5, ENTITY_SCHEMA_V1] },
      dependencies: [],
      runtimeManifest: { path: './runtime.json', schema: RUNTIME_SCHEMA_V5, digest: `sha256:${'0'.repeat(64)}` },
      entityTemplates: [{ agentId: 'lead', entityPath: './entities/lead/entity.json', digest }],
    }, null, 2)}\n`)
  }
  return { root, entry, configPath, entityPath, promptPath, writeManifest }
}

describe('local development package-v5 entity templates', () => {
  it('validates exact package declarations, watches entity bytes, and advances the artifact digest', async () => {
    const value = await fixture()
    const entityText = await readFile(value.entityPath, 'utf8')
    const firstPrompt = await readFile(value.promptPath, 'utf8')
    const firstEntityDigest = entityTreeDigest(entityText, [{ path: './prompts/role.md', text: firstPrompt }])
    await value.writeManifest(firstEntityDigest)

    const first = await buildLocalDevelopmentPlugin(value.entry)
    expect(first.entityTemplates).toMatchObject([{ declaration: { agentId: 'lead', digest: firstEntityDigest } }])
    expect(first.watchFiles).toEqual(expect.arrayContaining([value.entityPath, value.promptPath, path.join(value.root, 'cordisx-package.json')]))

    const secondEntityText = entityText.replace('"name": "Lead"', '"name": "Lead Revised"')
    await writeFile(value.entityPath, secondEntityText)
    const secondEntityDigest = entityTreeDigest(secondEntityText, [{ path: './prompts/role.md', text: firstPrompt }])
    await value.writeManifest(secondEntityDigest)
    const second = await buildLocalDevelopmentPlugin(value.entry)
    expect(second.digest).not.toBe(first.digest)
    expect(second.entityTemplates[0]?.declaration.digest).toBe(secondEntityDigest)

    const thirdPrompt = 'Updated Lead role from package.\n'
    await writeFile(value.promptPath, thirdPrompt)
    const thirdEntityDigest = entityTreeDigest(secondEntityText, [{ path: './prompts/role.md', text: thirdPrompt }])
    await value.writeManifest(thirdEntityDigest)
    const third = await buildLocalDevelopmentPlugin(value.entry)
    expect(third.digest).not.toBe(second.digest)
    expect(third.entityTemplates[0]?.declaration.digest).toBe(thirdEntityDigest)

    await value.writeManifest(thirdEntityDigest, 4)
    await expect(buildLocalDevelopmentPlugin(value.entry)).rejects.toThrow(/require plugin-package\.v5 or plugin-package\.v6/)
  })

  it('accepts package-v6 entity templates on the local development path', async () => {
    const value = await fixture()
    const entityText = await readFile(value.entityPath, 'utf8')
    const promptText = await readFile(value.promptPath, 'utf8')
    const digest = entityTreeDigest(entityText, [{ path: './prompts/role.md', text: promptText }])
    await value.writeManifest(digest, 6)
    await expect(buildLocalDevelopmentPlugin(value.entry)).resolves.toMatchObject({
      entityTemplates: [{ declaration: { agentId: 'lead', digest } }],
    })
  })

  it('fails closed for an invalid template path and a digest that does not match exact source bytes', async () => {
    const value = await fixture()
    await value.writeManifest(`sha256:${'b'.repeat(64)}`)
    await expect(buildLocalDevelopmentPlugin(value.entry)).rejects.toThrow(/digest mismatch/)

    const manifestPath = path.join(value.root, 'cordisx-package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entityTemplates: Array<Record<string, unknown>> }
    manifest.entityTemplates[0]!.entityPath = './entities/other/entity.json'
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await expect(buildLocalDevelopmentPlugin(value.entry)).rejects.toThrow(/invalid or duplicated/)
  })

  it('materializes once into the Playground profile and preserves local edits on later generations', async () => {
    const value = await fixture()
    const entityText = await readFile(value.entityPath, 'utf8')
    const promptText = await readFile(value.promptPath, 'utf8')
    await value.writeManifest(entityTreeDigest(entityText, [{ path: './prompts/role.md', text: promptText }]))
    const homeDir = path.join(value.root, 'home')
    const session = await createPlaygroundSession(value.configPath, { homeDir })
    const materialized = path.join(homeDir, 'profiles/playground/entities/lead/entity.json')
    try {
      await session.buildComposition('/runtime.ts')
      expect(await readFile(materialized, 'utf8')).toBe(entityText)

      const locallyEdited = entityText.replace('"name": "Lead"', '"name": "Locally Edited Lead"')
      await writeFile(materialized, locallyEdited)
      await session.buildComposition('/runtime.ts')
      expect(await readFile(materialized, 'utf8')).toBe(locallyEdited)
    } finally {
      await session.close()
    }
  })
})
