import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRiskCatalog } from '../packages/cli/src/capability-risk-catalog.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V3,
} from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV4 } from '../packages/cli/src/permission-model-v2.js'
import {
  JsonPackageManifestV2Resolver,
  PLUGIN_PACKAGE_SCHEMA_V2,
} from '../packages/cli/src/launcher/packages/manifest.js'
import {
  removeStagedPluginPackage,
  stageResolvedPluginPackage,
} from '../packages/cli/src/launcher/plugin-package.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(root => rm(root, { recursive: true, force: true })))
  temporary.clear()
})

async function fixture(packageVersion: 2 | 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-permission-package-'))
  temporary.add(root)
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src/index.js'), 'export function apply() {}\n')
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: 'permission-package',
    capabilities: [{
      name: 'models.read',
      required: true,
      rationale: {
        title: { key: 'models-title', fallback: 'Choose a model' },
        description: { key: 'models-description', fallback: 'Lists models for the model picker.' },
        feature: { key: 'models-feature', fallback: 'Model picker' },
        deniedBehavior: { key: 'models-denied', fallback: 'The model picker stays empty.' },
      },
      security: { dataUse: 'ephemeral', retention: 'none', externalTransfer: false },
      scope: { providers: ['codex'] },
    }],
    services: [],
  } as const
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await writeFile(path.join(root, 'runtime.json'), runtimeText)
  await writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify({
    $schema: packageVersion === 3 ? CORDISX_PLUGIN_PACKAGE_SCHEMA_V3 : PLUGIN_PACKAGE_SCHEMA_V2,
    schemaVersion: packageVersion,
    id: runtime.id,
    version: '1.0.0',
    entry: './src/index.js',
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V4] },
    dependencies: [],
    runtimeManifest: {
      path: './runtime.json',
      schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
    },
  }, null, 2)}\n`)
  return root
}

describe('permission manifest-v4 package boundary', () => {
  const catalog = new CapabilityRiskCatalog()
  const runtimeValidators = {
    [CORDISX_PLUGIN_MANIFEST_SCHEMA_V4]: (value: unknown) => normalizePluginManifestV4(value, 'permission-package', catalog),
  }

  it('accepts manifest-v4 only through formal package-v3', async () => {
    const root = await fixture(3)
    const resolved = await new JsonPackageManifestV2Resolver({ runtimeValidators }).resolve(root)
    expect(resolved.runtimeManifest).toMatchObject({ schemaVersion: 4, id: 'permission-package' })
    expect(resolved.packageManifest.runtimeManifest.schema).toBe(CORDISX_PLUGIN_MANIFEST_SCHEMA_V4)
  })

  it('keeps frozen package-v2 from consuming manifest-v4', async () => {
    const root = await fixture(2)
    await expect(new JsonPackageManifestV2Resolver({ runtimeValidators }).resolve(root))
      .rejects.toMatchObject({ code: 'incompatible-runtime' })
  })

  it('fails closed on unsupported scope even when the protocol capability name is valid', () => {
    expect(() => normalizePluginManifestV4({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      schemaVersion: 4,
      id: 'permission-package',
      capabilities: [{ name: 'tasks.control', required: true, scope: {} }],
      services: [],
    }, 'permission-package', catalog)).toThrow(/requires an explicit scope/)
  })

  it.each([
    ['initial', 'examples/plugins/permission-v2-smoke', '1.0.0'],
    ['updated', 'examples/plugins/permission-v2-smoke-expanded', '1.1.0'],
  ] as const)('stages and reads back the %s production permission smoke fixture', async (_label, source, version) => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-permission-smoke-store-'))
    temporary.add(homeDir)
    const sourceDirectory = path.resolve(source)
    const resolved = await new JsonPackageManifestV2Resolver({
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V4]: (value: unknown) => normalizePluginManifestV4(
          value,
          'permission-v2-smoke',
          catalog,
        ),
      },
    }).resolve(sourceDirectory)
    const staged = await stageResolvedPluginPackage(homeDir, sourceDirectory, resolved)
    try {
      expect(staged.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(staged.manifest).toMatchObject({
        id: 'permission-v2-smoke',
        version,
        runtimeManifest: { schemaVersion: 4 },
      })
      expect(staged.moduleSource).toContain('data-permission-v3-smoke-page')
    } finally {
      await removeStagedPluginPackage(homeDir, staged.digest)
    }
  })
})
