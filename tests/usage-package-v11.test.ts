import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11, normalizeUsageManifestV11 } from '../packages/cli/src/usage-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
  normalizeVisualManifestV10,
} from '../packages/cli/src/extension-point-interaction-permissions.js'
import {
  JsonPackageManifestV2Resolver,
  PLUGIN_PACKAGE_SCHEMA_V10,
  PLUGIN_PACKAGE_SCHEMA_V11,
} from '../packages/cli/src/launcher/packages/manifest.js'
import { buildLocalDevelopmentPlugin } from '../packages/cli/src/launcher/development.js'
import {
  loadStagedPluginPackage,
  removeStagedPluginPackage,
  stageResolvedPluginPackage,
} from '../packages/cli/src/launcher/plugin-package.js'

async function fixture(packageVersion = 11, runtimeVersion = 11) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-usage-package-'))
  const source = path.join(root, 'source')
  await mkdir(source)
  const runtimeSchema = runtimeVersion === 11 ? CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 : CORDISX_PLUGIN_MANIFEST_SCHEMA_V10
  const manifest = {
    $schema: runtimeSchema,
    schemaVersion: runtimeVersion,
    id: 'usage-pet',
    services: [],
    capabilities: [{ name: 'usage.read', required: false, scope: { profile: 'current' } }],
  }
  const bytes = JSON.stringify(manifest)
  const packageManifest = {
    $schema: packageVersion === 11 ? PLUGIN_PACKAGE_SCHEMA_V11 : PLUGIN_PACKAGE_SCHEMA_V10,
    schemaVersion: packageVersion,
    id: 'usage-pet',
    version: '0.1.0',
    entry: './usage-pet.js',
    dependencies: [],
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [runtimeSchema] },
    runtimeManifest: {
      path: './runtime.json',
      schema: runtimeSchema,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  }
  await Promise.all([
    writeFile(path.join(source, 'runtime.json'), bytes),
    writeFile(path.join(source, 'cordisx-package.json'), JSON.stringify(packageManifest)),
    writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'usage-pet', version: '0.1.0', type: 'module' }),
    ),
    writeFile(path.join(source, 'usage-pet.js'), 'export function apply() {}'),
  ])
  return { root, source, manifest, packageManifest }
}
function resolver() {
  return new JsonPackageManifestV2Resolver({
    runtimeValidators: {
      [CORDISX_PLUGIN_MANIFEST_SCHEMA_V11]: value => normalizeUsageManifestV11(value, 'usage-pet'),
      [CORDISX_PLUGIN_MANIFEST_SCHEMA_V10]: value => normalizeVisualManifestV10(value, 'usage-pet'),
    },
  })
}
it('stages the same v11 usage declaration through formal and local development admission', async () => {
  const { root, source, manifest } = await fixture()
  try {
    const local = await buildLocalDevelopmentPlugin(path.join(source, 'usage-pet.js'))
    expect(local.manifest).toMatchObject(manifest)
    const resolved = await resolver().resolve(source)
    const staged = await stageResolvedPluginPackage(path.join(root, 'home'), source, resolved)
    expect(staged.manifest.runtimeManifest).toMatchObject(manifest)
    expect((await loadStagedPluginPackage(path.join(root, 'home'), staged.digest)).manifest.runtimeManifest)
      .toMatchObject(manifest)
    await removeStagedPluginPackage(path.join(root, 'home'), staged.digest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it.each([[11, 10], [10, 11]])(
  'rejects package/runtime version mismatch %s/%s in both paths',
  async (packageVersion, runtimeVersion) => {
    const { root, source } = await fixture(packageVersion, runtimeVersion)
    try {
      await expect(resolver().resolve(source)).rejects.toThrow()
      await expect(buildLocalDevelopmentPlugin(path.join(source, 'usage-pet.js'))).rejects.toThrow(
        'runtimeManifest declaration is invalid',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
it('does not smuggle usage.read into unchanged v10 semantics', async () => {
  const { root, source } = await fixture(10, 10)
  try {
    await expect(resolver().resolve(source)).rejects.toThrow()
    await expect(buildLocalDevelopmentPlugin(path.join(source, 'usage-pet.js'))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('rejects mismatched package schemaVersion and v11 schema URI', async () => {
  const { root, source, packageManifest } = await fixture()
  try {
    await writeFile(
      path.join(source, 'cordisx-package.json'),
      JSON.stringify({ ...packageManifest, schemaVersion: 10 }),
    )
    await expect(resolver().resolve(source)).rejects.toThrow('package manifest must use')
    await expect(buildLocalDevelopmentPlugin(path.join(source, 'usage-pet.js'))).rejects.toThrow('requires exact')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
