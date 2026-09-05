import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import {
  type HostResolvedRuntimeManifest,
  stagePluginPackageSourceV1,
} from '../packages/cli/src/launcher/packages/index.js'
import { entityTreeDigest } from '../packages/cli/src/launcher/entity-directory.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all([...roots].map(async root => await rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('plugin package v5 entity templates', () => {
  it('stages exact template bytes in the immutable package and rejects undeclared schema compatibility', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-entity-package-'))
    roots.add(root)
    const source = path.join(root, 'source')
    const homeDir = path.join(root, 'home')
    await mkdir(path.join(source, 'src'), { recursive: true })
    await mkdir(path.join(source, 'entities/lead/prompts'), { recursive: true })
    await writeFile(path.join(source, 'src/index.ts'), 'export function apply() {}\n')
    const runtime = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1,
      id: 'entity-fixture',
      capabilities: [],
    } as const
    const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
    await writeFile(path.join(source, 'runtime.json'), runtimeText)
    const entity = {
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json',
      contract: 'cordisx.entity-file/v1',
      schemaVersion: 1,
      agentId: 'lead',
      name: 'Lead',
      inherit: {
        promptSections: 'none',
        rules: 'none',
        skills: 'none',
        tools: 'none',
        mcpServers: 'none',
        runtimeDefaults: 'none',
      },
      promptSections: [{ sectionId: 'role', kind: 'role', source: { kind: 'markdown', path: './prompts/role.md' } }],
    } as const
    const entityText = `${JSON.stringify(entity, null, 2)}\n`
    const promptText = 'Package exact role.\n'
    await writeFile(path.join(source, 'entities/lead/entity.json'), entityText)
    await writeFile(path.join(source, 'entities/lead/prompts/role.md'), promptText)
    const declaration = {
      agentId: 'lead',
      entityPath: './entities/lead/entity.json' as const,
      digest: entityTreeDigest(entityText, [{ path: './prompts/role.md', text: promptText }]),
    }
    const manifest = (includeEntitySchema: boolean) => ({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v5.schema.json',
      schemaVersion: 5,
      id: 'entity-fixture',
      version: '1.0.0',
      entry: './src/index.ts',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      compatibility: {
        runtimeAbi: 1,
        protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1, ...(includeEntitySchema ? [entity.$schema] : [])],
      },
      dependencies: [],
      runtimeManifest: {
        path: './runtime.json',
        schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
      },
      entityTemplates: [declaration],
    })
    await writeFile(path.join(source, 'cordisx-package.json'), `${JSON.stringify(manifest(false), null, 2)}\n`)
    const runtimeValidators = {
      [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1]: (value: unknown) => value as HostResolvedRuntimeManifest,
    }
    await expect(
      stagePluginPackageSourceV1({ kind: 'local-directory', location: new URL(`file://${source}/`).href }, {
        homeDir,
        runtimeValidators,
      }),
    )
      .rejects.toMatchObject({ code: 'incompatible-runtime' })
    await writeFile(path.join(source, 'cordisx-package.json'), `${JSON.stringify(manifest(true), null, 2)}\n`)
    const staged = await stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: new URL(`file://${source}/`).href,
    }, { homeDir, runtimeValidators })
    expect(staged.entityTemplates).toEqual([{
      declaration,
      entityText,
      promptFiles: [{ path: './prompts/role.md', text: promptText }],
    }])
    await removeStagedPluginPackage(homeDir, staged.digest)
  })
})
