import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRiskCatalog } from '../packages/cli/src/capability-risk-catalog.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V6 } from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV6 } from '../packages/cli/src/permission-model-v4.js'
import {
  JsonPackageManifestV2Resolver,
  PLUGIN_PACKAGE_SCHEMA_V5,
  PLUGIN_PACKAGE_SCHEMA_V6,
} from '../packages/cli/src/launcher/packages/manifest.js'
import {
  loadStagedPluginPackage,
  removeStagedPluginPackage,
  stageResolvedPluginPackage,
} from '../packages/cli/src/launcher/plugin-package.js'
import { entityTreeDigest } from '../packages/cli/src/launcher/entity-directory.js'

const entitySchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json'

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all([...roots].map(async root => await rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function fixture(packageVersion: 5 | 6): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-package-v6-'))
  roots.add(root)
  await mkdir(path.join(root, 'src'), { recursive: true })
  await mkdir(path.join(root, 'entities/lead/prompts'), { recursive: true })
  await writeFile(path.join(root, 'src/index.js'), 'export function apply() {}\n')
  const entity = {
    $schema: entitySchema,
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
  }
  const entityText = `${JSON.stringify(entity, null, 2)}\n`
  const promptText = 'Lead approval route fixture.\n'
  await writeFile(path.join(root, 'entities/lead/entity.json'), entityText)
  await writeFile(path.join(root, 'entities/lead/prompts/role.md'), promptText)
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
    schemaVersion: 6,
    id: 'chatroom-v6',
    services: [],
    capabilities: [{
      name: 'approvals.request',
      required: false,
      scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } },
    }],
  }
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await writeFile(path.join(root, 'runtime.json'), runtimeText)
  await writeFile(
    path.join(root, 'cordisx-package.json'),
    `${
      JSON.stringify(
        {
          $schema: packageVersion === 6 ? PLUGIN_PACKAGE_SCHEMA_V6 : PLUGIN_PACKAGE_SCHEMA_V5,
          schemaVersion: packageVersion,
          id: runtime.id,
          version: '1.0.0',
          entry: './src/index.js',
          distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
          compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V6, entitySchema] },
          dependencies: [],
          runtimeManifest: {
            path: './runtime.json',
            schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
            digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
          },
          entityTemplates: [{
            agentId: 'lead',
            entityPath: './entities/lead/entity.json',
            digest: entityTreeDigest(entityText, [{ path: './prompts/role.md', text: promptText }]),
          }],
        },
        null,
        2,
      )
    }\n`,
  )
  return root
}

describe('plugin-package/v6 Host boundary', () => {
  const resolver = () =>
    new JsonPackageManifestV2Resolver({
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V6]: value =>
          normalizePluginManifestV6(value, 'chatroom-v6', new CapabilityRiskCatalog()),
      },
    })

  it('loads a package-v6 exact approval route manifest', async () => {
    const source = await fixture(6)
    const resolved = await resolver().resolve(source)
    expect(resolved.runtimeManifest).toMatchObject({ schemaVersion: 6, id: 'chatroom-v6' })
    expect(resolved.packageManifest.runtimeManifest.schema).toBe(CORDISX_PLUGIN_MANIFEST_SCHEMA_V6)
    const staged = await stageResolvedPluginPackage(path.join(source, '.host-home'), source, resolved)
    expect(staged.manifest.runtimeManifest).toMatchObject({ schemaVersion: 6, id: 'chatroom-v6' })
    expect(staged.entityTemplates).toHaveLength(1)
    await expect(loadStagedPluginPackage(path.join(source, '.host-home'), staged.digest))
      .resolves.toMatchObject({ manifest: { runtimeManifest: { schemaVersion: 6, id: 'chatroom-v6' } } })
    await removeStagedPluginPackage(path.join(source, '.host-home'), staged.digest)
  })

  it('does not let frozen package-v5 claim manifest-v6', async () => {
    await expect(resolver().resolve(await fixture(5))).rejects.toMatchObject({ code: 'incompatible-runtime' })
  })
})
